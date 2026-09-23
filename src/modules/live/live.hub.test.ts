/**
 * The live hub (DESIGN §4.7, API §6): delivery by target, the envelope, stream limits with eviction of the oldest,
 * closing, coalescing (`sync.changed`: leading event, then one trailing event per window), and the order of
 * `afterRemove` (session.invalidated → close → devices.updated).
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ManualClock } from "../../lib/clock.ts";
import { afterRemove } from "../../lib/device-removal.ts";
import { formatIso } from "../../lib/time.ts";
import { LiveHub } from "./live.hub.ts";
import type { LiveCloseReason, LiveStreamHandle, LiveTimers } from "./live.hub.ts";
import type { LiveEvent } from "./live.events.ts";

const T0 = Date.UTC(2026, 8, 23, 10, 0, 0);
const USER = "0c3f6a2e-5d1b-4c7a-9e8f-1a2b3c4d5e6f";
const OTHER_USER = "1d4f7b3e-6e2c-4d8b-8f9a-2b3c4d5e6f70";
const DEV_A = "9b1e2f4a-7c3d-4e5f-8a9b-0c1d2e3f4a5b";
const DEV_B = "77b2c1d0-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
const DEV_C = "41c0d1e2-f3a4-4b5c-8d6e-7f8a9b0c1d2e";

type Log = { level: "warn" | "error"; message: string }[];

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

  /** Fires every pending timer once (in creation order). */
  fireAll(): void {
    const due = [...this.pending.entries()];
    this.pending.clear();
    for (const [, timer] of due) timer.callback();
  }
}

type Recorded = { events: LiveEvent[]; closed: LiveCloseReason[] };

function setup(options: { perDevice?: number; perUser?: number } = {}) {
  const clock = new ManualClock(T0);
  const log: Log = [];
  const timers = new FakeTimers();
  let ids = 0;
  const hub = new LiveHub({
    clock,
    log: {
      warn: (_details, message) => log.push({ level: "warn", message }),
      error: (_details, message) => log.push({ level: "error", message }),
    },
    maxStreamsPerDevice: options.perDevice ?? 4,
    maxStreamsPerUser: options.perUser ?? 64,
    timers,
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
  });
  const open = (userId: string, deviceId: string, overrides: Partial<LiveStreamHandle> = {}) => {
    const recorded: Recorded = { events: [], closed: [] };
    const registration = hub.register({
      userId,
      deviceId,
      authVersion: 1,
      expiresAt: T0 + 900_000,
      send: (event) => recorded.events.push(event),
      close: (reason) => recorded.closed.push(reason),
      ...overrides,
    });
    return { ...registration, recorded };
  };
  return { hub, clock, log, timers, open };
}

describe("LiveHub.publish", () => {
  test("every device, one device, every device but one; other users never", () => {
    const { hub, open } = setup();
    const a = open(USER, DEV_A);
    const b = open(USER, DEV_B);
    const stranger = open(OTHER_USER, DEV_C);
    const payload = { reason: "device_added", deviceId: DEV_C } as const;

    hub.publish(USER, "devices.updated", payload);
    hub.publish(USER, "devices.updated", payload, { onlyDeviceId: DEV_B });
    hub.publish(USER, "devices.updated", payload, { exceptDeviceId: DEV_B });

    assert.equal(a.recorded.events.length, 2);
    assert.equal(b.recorded.events.length, 2);
    assert.equal(stranger.recorded.events.length, 0);
  });

  test("the envelope is {id, type, at, payload} with the time of the clock", () => {
    const { hub, clock, open } = setup();
    const a = open(USER, DEV_A);
    clock.advance(1234);
    hub.publish(USER, "sync.changed", { cursor: "a1b2c3d4.5.5" });
    assert.deepEqual(a.recorded.events, [
      {
        id: "00000000-0000-4000-8000-000000000002",
        type: "sync.changed",
        at: formatIso(T0 + 1234),
        payload: { cursor: "a1b2c3d4.5.5" },
      },
    ]);
  });

  test("an invalid payload is dropped and logged, never thrown", () => {
    const { hub, log, open } = setup();
    const a = open(USER, DEV_A);
    assert.doesNotThrow(() => {
      hub.publish(USER, "sync.changed", { cursor: 42 } as unknown as { cursor: string });
    });
    assert.equal(a.recorded.events.length, 0);
    assert.deepEqual(
      log.map((entry) => entry.level),
      ["error"],
    );
  });

  test("a stream whose send throws is closed and forgotten; the others still receive", () => {
    const { hub, open } = setup();
    const broken = open(USER, DEV_A, {
      send: () => {
        throw new Error("socket gone");
      },
    });
    const b = open(USER, DEV_B);
    hub.publish(USER, "devices.updated", { reason: "device_renamed", deviceId: DEV_A });
    assert.deepEqual(broken.recorded.closed, ["device_closed"]);
    assert.equal(b.recorded.events.length, 1);
    assert.equal(hub.count(USER), 1);
  });
});

describe("LiveHub limits and closing", () => {
  test("the fifth stream of a device evicts the oldest one of that device (API §6)", () => {
    const { hub, open } = setup();
    const streams = [1, 2, 3, 4, 5].map(() => open(USER, DEV_A));
    const other = open(USER, DEV_B);
    assert.deepEqual(streams[0]!.recorded.closed, ["evicted"]);
    for (const stream of streams.slice(1)) assert.deepEqual(stream.recorded.closed, []);
    assert.deepEqual(other.recorded.closed, []);
    assert.equal(hub.count(USER), 5);
  });

  test("beyond the per-user limit the oldest stream of the user is evicted", () => {
    const { hub, open } = setup({ perDevice: 4, perUser: 3 });
    const first = open(USER, DEV_A);
    const second = open(USER, DEV_B);
    open(USER, DEV_C);
    open(USER, DEV_C);
    assert.deepEqual(first.recorded.closed, ["evicted"]);
    assert.deepEqual(second.recorded.closed, []);
    assert.equal(hub.count(USER), 3);
  });

  test("closeDevice, closeUser, closeAll; unregister forgets without closing", () => {
    const { hub, open } = setup();
    const a1 = open(USER, DEV_A);
    const a2 = open(USER, DEV_A);
    const b = open(USER, DEV_B);
    const stranger = open(OTHER_USER, DEV_C);

    hub.closeDevice(USER, DEV_A);
    assert.deepEqual(
      [a1.recorded.closed, a2.recorded.closed, b.recorded.closed],
      [["device_closed"], ["device_closed"], []],
    );

    b.unregister();
    b.unregister();
    assert.deepEqual(b.recorded.closed, []);
    assert.equal(hub.count(USER), 0);

    const c = open(USER, DEV_C);
    hub.closeUser(USER);
    assert.deepEqual(c.recorded.closed, ["user_closed"]);

    hub.closeAll();
    assert.deepEqual(stranger.recorded.closed, ["shutdown"]);
    assert.equal(hub.count(), 0);
    assert.deepEqual(hub.streams(), []);
  });

  test("afterRemove: session.invalidated, then the streams close, then devices.updated to the others", () => {
    const { hub, open } = setup();
    const order: string[] = [];
    open(USER, DEV_A, {
      send: (event) => order.push(`A:${event.type}`),
      close: (reason) => order.push(`A:close:${reason}`),
    });
    open(USER, DEV_B, {
      send: (event) => order.push(`B:${event.type}`),
      close: (reason) => order.push(`B:close:${reason}`),
    });
    afterRemove(hub, { userId: USER, deviceIds: [DEV_A], reason: "device_revoked" });
    assert.deepEqual(order, ["A:session.invalidated", "A:close:device_closed", "B:devices.updated"]);
  });
});

describe("LiveHub.publishCoalesced", () => {
  test("leading event at once, later ones merge into one trailing event with the latest payload", () => {
    const { hub, timers, open } = setup();
    const b = open(USER, DEV_B);
    hub.publishCoalesced(USER, "sync.changed", { cursor: "a1b2c3d4.1.1" }, { excludeDeviceId: DEV_A });
    hub.publishCoalesced(USER, "sync.changed", { cursor: "a1b2c3d4.2.2" }, { excludeDeviceId: DEV_A });
    hub.publishCoalesced(USER, "sync.changed", { cursor: "a1b2c3d4.3.3" }, { excludeDeviceId: DEV_A });
    assert.deepEqual(
      b.recorded.events.map((event) => event.payload),
      [{ cursor: "a1b2c3d4.1.1" }],
    );
    assert.equal([...timers.pending.values()][0]?.ms, 2000);

    timers.fireAll();
    assert.deepEqual(
      b.recorded.events.map((event) => event.payload),
      [{ cursor: "a1b2c3d4.1.1" }, { cursor: "a1b2c3d4.3.3" }],
    );
    // A quiet window closes the slot: the next event is a leading one again.
    timers.fireAll();
    assert.equal(timers.pending.size, 0);
    hub.publishCoalesced(USER, "sync.changed", { cursor: "a1b2c3d4.4.4" }, { excludeDeviceId: DEV_A });
    assert.equal(b.recorded.events.length, 3);
  });

  test("the author is skipped only when every merged event had the same author", () => {
    const { hub, timers, open } = setup();
    const a = open(USER, DEV_A);
    const b = open(USER, DEV_B);
    hub.publishCoalesced(USER, "sync.changed", { cursor: "a1b2c3d4.1.1" }, { excludeDeviceId: DEV_A });
    hub.publishCoalesced(USER, "sync.changed", { cursor: "a1b2c3d4.2.2" }, { excludeDeviceId: DEV_A });
    timers.fireAll();
    assert.equal(a.recorded.events.length, 0);
    assert.equal(b.recorded.events.length, 2);

    timers.fireAll(); // quiet window: slot closed
    hub.publishCoalesced(USER, "sync.changed", { cursor: "a1b2c3d4.3.3" }, { excludeDeviceId: DEV_A });
    hub.publishCoalesced(USER, "sync.changed", { cursor: "a1b2c3d4.4.4" }, { excludeDeviceId: DEV_B });
    hub.publishCoalesced(USER, "sync.changed", { cursor: "a1b2c3d4.5.5" }, { excludeDeviceId: DEV_A });
    timers.fireAll();
    // The leading 3.3 went to B only; the trailing 5.5 merges writes of A and B, so both receive it.
    assert.deepEqual(
      a.recorded.events.map((event) => event.payload),
      [{ cursor: "a1b2c3d4.5.5" }],
    );
    assert.deepEqual(
      b.recorded.events.map((event) => event.payload),
      [{ cursor: "a1b2c3d4.1.1" }, { cursor: "a1b2c3d4.2.2" }, { cursor: "a1b2c3d4.3.3" }, { cursor: "a1b2c3d4.5.5" }],
    );

    timers.fireAll(); // quiet window: slot closed
    hub.publishCoalesced(USER, "sync.changed", { cursor: "a1b2c3d4.6.6" }, { excludeDeviceId: DEV_A });
    hub.publishCoalesced(USER, "sync.changed", { cursor: "a1b2c3d4.7.7" }, { excludeDeviceId: DEV_B });
    timers.fireAll();
    // Trailing 7.7 has one author (B): A receives it, B does not.
    assert.deepEqual(
      a.recorded.events.map((event) => event.payload),
      [{ cursor: "a1b2c3d4.5.5" }, { cursor: "a1b2c3d4.7.7" }],
    );
    assert.equal(b.recorded.events.length, 5);
  });

  test("windows are per user and type; playback.updated uses 1 s; closeAll drops pending events", () => {
    const { hub, timers, open } = setup();
    const b = open(USER, DEV_B);
    const other = open(OTHER_USER, DEV_C);
    hub.publishCoalesced(USER, "sync.changed", { cursor: "a1b2c3d4.1.1" });
    hub.publishCoalesced(OTHER_USER, "sync.changed", { cursor: "a1b2c3d4.9.9" });
    hub.publishCoalesced(USER, "playback.updated", { rev: 1, cleared: true, state: null });
    assert.equal(b.recorded.events.length, 2);
    assert.equal(other.recorded.events.length, 1);
    assert.deepEqual(
      [...timers.pending.values()].map((timer) => timer.ms),
      [2000, 2000, 1000],
    );
    hub.publishCoalesced(USER, "sync.changed", { cursor: "a1b2c3d4.2.2" });
    hub.closeAll();
    assert.equal(timers.pending.size, 0);
    assert.equal(b.recorded.events.length, 2);
  });
});
