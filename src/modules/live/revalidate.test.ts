/**
 * The heartbeat recheck without a database (DESIGN §4.7): what the rows mean for each stream, the order of the effects
 * (session.invalidated before the close, like DESIGN §4.6), and the heartbeat loop (lazy start, stop when idle, no
 * overlapping rechecks, stop waits for the recheck in flight). The query itself is in `revalidate.int.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ManualClock } from "../../lib/clock.ts";
import { LiveHub } from "./live.hub.ts";
import type { LiveCloseReason, LiveStream, LiveTimers } from "./live.hub.ts";
import type { LiveEvent } from "./live.events.ts";
import { LiveHeartbeat, applyRevalidation, planRevalidation, revalidateStreams } from "./revalidate.ts";
import type { DeviceSession } from "./revalidate.ts";

const T0 = Date.UTC(2026, 8, 23, 10, 0, 0);
const USER = "0c3f6a2e-5d1b-4c7a-9e8f-1a2b3c4d5e6f";
const OTHER_USER = "1d4f7b3e-6e2c-4d8b-8f9a-2b3c4d5e6f70";
const DEV_A = "9b1e2f4a-7c3d-4e5f-8a9b-0c1d2e3f4a5b";
const DEV_B = "77b2c1d0-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
const DEV_C = "41c0d1e2-f3a4-4b5c-8d6e-7f8a9b0c1d2e";

class FakeTimers implements LiveTimers {
  #next = 1;
  readonly pending = new Map<number, { callback: () => void; ms: number }>();

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.#next++;
    this.pending.set(id, { callback, ms });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  /** Fires the pending timers of this delay. */
  fire(ms: number): number {
    const due = [...this.pending.entries()].filter(([, timer]) => timer.ms === ms);
    for (const [id] of due) this.pending.delete(id);
    for (const [, timer] of due) timer.callback();
    return due.length;
  }
}

type Trace = string[];

function setup() {
  const clock = new ManualClock(T0);
  const timers = new FakeTimers();
  const hub = new LiveHub({
    clock,
    log: { warn: () => undefined, error: () => undefined },
    maxStreamsPerDevice: 4,
    maxStreamsPerUser: 64,
    timers,
  });
  const trace: Trace = [];
  const open = (userId: string, deviceId: string, authVersion = 1, name = deviceId.slice(0, 4)) =>
    hub.register({
      userId,
      deviceId,
      authVersion,
      expiresAt: T0 + 900_000,
      send: (event: LiveEvent) => trace.push(`${name}:${event.type}:${JSON.stringify(event.payload)}`),
      ping: (now) => trace.push(`${name}:ping:${now}`),
      close: (reason: LiveCloseReason) => trace.push(`${name}:close:${reason}`),
    }).stream;
  return { clock, timers, hub, trace, open };
}

const session = (deviceId: string, userId: string, authVersion = 1, userDeletedAt: number | null = null) =>
  ({ deviceId, userId, authVersion, userDeletedAt }) satisfies DeviceSession;

describe("planRevalidation", () => {
  test("gone device → device_revoked; deleted user → account_deleted; other av → outdated; the rest untouched", () => {
    const { open } = setup();
    const gone1 = open(USER, DEV_A, 1);
    const gone2 = open(USER, DEV_A, 1);
    const current = open(USER, DEV_B, 2);
    const stale = open(USER, DEV_B, 1);
    const deleted = open(OTHER_USER, DEV_C, 1);
    const plan = planRevalidation(
      [gone1, gone2, current, stale, deleted],
      [session(DEV_B, USER, 2), session(DEV_C, OTHER_USER, 1, T0)],
    );
    assert.deepEqual(plan.invalidated, [
      { userId: USER, deviceId: DEV_A, reason: "device_revoked" },
      { userId: OTHER_USER, deviceId: DEV_C, reason: "account_deleted" },
    ]);
    assert.deepEqual(plan.outdated, [stale]);
  });

  test("a device row of another user counts as gone (the stream's session is not that row)", () => {
    const { open } = setup();
    const stream = open(USER, DEV_A);
    const plan = planRevalidation([stream], [session(DEV_A, OTHER_USER)]);
    assert.deepEqual(plan.invalidated, [{ userId: USER, deviceId: DEV_A, reason: "device_revoked" }]);
    assert.deepEqual(plan.outdated, []);
  });

  test("an av higher than the user's also closes (restored backup): any difference is outdated", () => {
    const { open } = setup();
    const stream = open(USER, DEV_A, 3);
    assert.deepEqual(planRevalidation([stream], [session(DEV_A, USER, 2)]).outdated, [stream]);
  });
});

describe("applyRevalidation", () => {
  test("session.invalidated to the device, then its streams close; outdated streams close without an event", () => {
    const { hub, trace, open } = setup();
    open(USER, DEV_A, 1, "A1");
    open(USER, DEV_A, 1, "A2");
    const stale = open(USER, DEV_B, 1, "B");
    open(USER, DEV_C, 1, "C");
    applyRevalidation(hub, {
      invalidated: [{ userId: USER, deviceId: DEV_A, reason: "device_revoked" }],
      outdated: [stale],
    });
    const invalidated = JSON.stringify({ reason: "device_revoked", forceRelogin: true });
    assert.deepEqual(trace, [
      `A1:session.invalidated:${invalidated}`,
      `A2:session.invalidated:${invalidated}`,
      "A1:close:device_closed",
      "A2:close:device_closed",
      "B:close:outdated",
    ]);
    assert.equal(hub.count(USER), 1);
  });

  test("revalidateStreams: no streams, no query", async () => {
    const { hub } = setup();
    let queries = 0;
    const db = {
      run: () => {
        queries += 1;
        return Promise.resolve([]);
      },
    } as unknown as Parameters<typeof revalidateStreams>[0]["db"];
    const plan = await revalidateStreams({ db, hub }, []);
    assert.deepEqual(plan, { invalidated: [], outdated: [] });
    assert.equal(queries, 0);
  });
});

describe("LiveHeartbeat", () => {
  function loop(options: { revalidate?: (streams: readonly LiveStream[]) => Promise<unknown> } = {}) {
    const base = setup();
    const errors: string[] = [];
    const rechecks: (readonly LiveStream[])[] = [];
    const heartbeat = new LiveHeartbeat({
      hub: base.hub,
      timers: base.timers,
      intervalMs: 25_000,
      log: { error: (_details, message) => errors.push(message) },
      revalidate:
        options.revalidate ??
        ((streams) => {
          rechecks.push(streams);
          return Promise.resolve();
        }),
    });
    return { ...base, heartbeat, errors, rechecks };
  }

  test("starts lazily, pings and rechecks the open streams every interval, stops when no stream is left", async () => {
    const { heartbeat, timers, clock, hub, trace, open, rechecks } = loop();
    assert.equal(heartbeat.active, false);
    const a = open(USER, DEV_A, 1, "A");
    heartbeat.start();
    heartbeat.start();
    assert.equal(timers.pending.size, 1);
    assert.equal([...timers.pending.values()][0]?.ms, 25_000);

    clock.advance(25_000);
    assert.equal(timers.fire(25_000), 1);
    assert.deepEqual(trace, [`A:ping:${T0 + 25_000}`]);
    assert.deepEqual(rechecks, [[a]]);
    assert.equal(heartbeat.active, true);
    await Promise.resolve();

    hub.closeStream(a, "expired");
    timers.fire(25_000);
    assert.equal(heartbeat.active, false);
    assert.equal(timers.pending.size, 0);
    assert.equal(rechecks.length, 1);

    open(USER, DEV_B, 1, "B");
    heartbeat.start();
    assert.equal(heartbeat.active, true);
    await heartbeat.stop();
    assert.equal(timers.pending.size, 0);
    heartbeat.start();
    assert.equal(heartbeat.active, false, "a stopped loop never starts again");
  });

  test("a recheck still running is not started again; a failing recheck is logged and the loop goes on", async () => {
    let release: (() => void) | undefined;
    let calls = 0;
    const { heartbeat, timers, open, errors } = loop({
      revalidate: () => {
        calls += 1;
        if (calls === 1) return new Promise<void>((resolve) => (release = resolve));
        return Promise.reject(new Error("database is down"));
      },
    });
    open(USER, DEV_A);
    heartbeat.start();
    timers.fire(25_000);
    timers.fire(25_000);
    assert.equal(calls, 1, "the second beat only pings while the first recheck runs");
    release?.();
    await new Promise((resolve) => setImmediate(resolve));
    timers.fire(25_000);
    assert.equal(calls, 2);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(errors, ["live streams: the heartbeat recheck of devices failed"]);
    assert.equal(heartbeat.active, true);
    await heartbeat.stop();
  });

  test("stop waits for the recheck in flight", async () => {
    let release: (() => void) | undefined;
    const { heartbeat, timers, open } = loop({
      revalidate: () => new Promise<void>((resolve) => (release = resolve)),
    });
    open(USER, DEV_A);
    heartbeat.start();
    timers.fire(25_000);
    let stopped = false;
    const stopping = heartbeat.stop().then(() => (stopped = true));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopped, false);
    release?.();
    await stopping;
    assert.equal(stopped, true);
  });

  test("the interval must be a positive integer", () => {
    const { hub, timers } = setup();
    assert.throws(
      () =>
        new LiveHeartbeat({
          hub,
          timers,
          intervalMs: 0,
          log: { error: () => undefined },
          revalidate: () => Promise.resolve(),
        }),
      RangeError,
    );
  });
});
