/**
 * The job scheduler (API §5): next run times (interval, daily with jitter), runs on time, no overlap, failures logged
 * and rescheduled, several schedules per job, stop aborts and waits.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DAY_MS, HOUR_MS, ManualClock, MINUTE_MS } from "../lib/clock.ts";
import { nextRunAt, Scheduler, SchedulerError } from "./scheduler.ts";
import type { JobRunContext, SchedulerTimers } from "./scheduler.ts";

const MIDNIGHT = Date.UTC(2026, 8, 23);
const RETENTION = { hour: 4, minute: 30 };

/** Timers driven by a manual clock: `advance` fires every timer that became due, in time order. */
class ClockTimers implements SchedulerTimers {
  readonly #clock: ManualClock;
  #next = 1;
  readonly #pending = new Map<number, { at: number; callback: () => void }>();

  constructor(clock: ManualClock) {
    this.#clock = clock;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.#next++;
    this.#pending.set(id, { at: this.#clock.now() + ms, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#pending.delete(handle as number);
  }

  get size(): number {
    return this.#pending.size;
  }

  async advance(ms: number): Promise<void> {
    const end = this.#clock.now() + ms;
    for (;;) {
      const due = [...this.#pending.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at);
      const first = due[0];
      if (!first) break;
      this.#pending.delete(first[0]);
      this.#clock.set(Math.max(this.#clock.now(), first[1].at));
      first[1].callback();
      await flush();
    }
    this.#clock.set(end);
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

function setup(start = MIDNIGHT) {
  const clock = new ManualClock(start);
  const timers = new ClockTimers(clock);
  const log: { level: string; message: string; job?: string }[] = [];
  const logger = {
    info: (details: object, message: string) => log.push({ level: "info", message, ...details }),
    warn: (details: object, message: string) => log.push({ level: "warn", message, ...details }),
    error: (details: object, message: string) => log.push({ level: "error", message, ...details }),
  };
  const scheduler = new Scheduler({ clock, log: logger, random: () => 0.5, timers });
  return { clock, timers, log, scheduler };
}

describe("nextRunAt", () => {
  test("interval: first after firstDelayMs (default: the interval), then previous + interval", () => {
    assert.equal(nextRunAt({ every: HOUR_MS }, MIDNIGHT, null), MIDNIGHT + HOUR_MS);
    assert.equal(nextRunAt({ every: HOUR_MS, firstDelayMs: 0 }, MIDNIGHT, null), MIDNIGHT);
    assert.equal(nextRunAt({ every: HOUR_MS }, MIDNIGHT + 10, MIDNIGHT), MIDNIGHT + HOUR_MS);
    // A long pause (suspended laptop) does not replay missed runs.
    assert.equal(nextRunAt({ every: HOUR_MS }, MIDNIGHT + 5 * HOUR_MS, MIDNIGHT), MIDNIGHT + 5 * HOUR_MS + 1);
  });

  test("daily: the next HH:MM UTC plus a jitter within ±jitterMs, never twice a day", () => {
    const at = MIDNIGHT + (4 * 60 + 30) * MINUTE_MS;
    assert.equal(nextRunAt({ dailyAt: RETENTION }, MIDNIGHT, null), at);
    assert.equal(nextRunAt({ dailyAt: RETENTION }, at, null), at + DAY_MS);
    const jitter = 10 * MINUTE_MS;
    assert.equal(
      nextRunAt({ dailyAt: RETENTION, jitterMs: jitter }, MIDNIGHT, null, () => 0),
      at - jitter,
    );
    assert.equal(
      nextRunAt({ dailyAt: RETENTION, jitterMs: jitter }, MIDNIGHT, null, () => 0.75),
      at + jitter / 2,
    );
    // Ran at 04:20 (jitter −10 min); a new draw of +5 min must not run it again at 04:35 the same day.
    const ran = at - jitter;
    const next = nextRunAt({ dailyAt: RETENTION, jitterMs: jitter }, ran + 1, ran, () => 0.75);
    assert.equal(next, at + DAY_MS + jitter / 2);
  });
});

describe("Scheduler", () => {
  test("interval jobs run on time; a failure is logged and the job stays scheduled", async () => {
    const { timers, log, scheduler } = setup();
    const runs: number[] = [];
    let fail = true;
    scheduler.add({
      name: "auth-cleanup",
      schedules: [{ every: HOUR_MS }],
      run: (job) => {
        runs.push(job.startedAt);
        if (fail) {
          fail = false;
          return Promise.reject(new Error("boom"));
        }
        return Promise.resolve();
      },
    });
    scheduler.start();
    await timers.advance(3 * HOUR_MS);
    assert.deepEqual(runs, [MIDNIGHT + HOUR_MS, MIDNIGHT + 2 * HOUR_MS, MIDNIGHT + 3 * HOUR_MS]);
    assert.deepEqual(
      log.filter((entry) => entry.level === "error").map((entry) => entry.job),
      ["auth-cleanup"],
    );
    const status = scheduler.status()[0]!;
    assert.equal(status.lastError, null);
    assert.equal(status.nextRunAt, MIDNIGHT + 4 * HOUR_MS);
    await scheduler.stop();
    assert.equal(timers.size, 0);
  });

  test("a job never overlaps itself; stop aborts its signal and waits for it", async () => {
    const { timers, log, scheduler } = setup();
    let release: () => void = () => undefined;
    let started = 0;
    let signal: AbortSignal | null = null;
    scheduler.add({
      name: "retention",
      schedules: [{ every: MINUTE_MS }],
      run: (job: JobRunContext) => {
        started += 1;
        signal = job.signal;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    scheduler.start();
    await timers.advance(3 * MINUTE_MS);
    assert.equal(started, 1);
    assert.equal(log.filter((entry) => entry.message.includes("still running")).length, 2);
    assert.equal(await scheduler.runNow("retention"), "skipped_running");

    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await flush();
    assert.equal((signal as AbortSignal | null)?.aborted, true);
    assert.equal(stopped, false);
    release();
    await stopping;
    assert.equal(stopped, true);
    assert.equal(await scheduler.runNow("retention"), "stopped");
  });

  test("several schedules of one job keep their own plan (sqlite-maintenance: every 6 h and daily)", async () => {
    const { timers, scheduler } = setup();
    const runs: number[] = [];
    scheduler.add({
      name: "sqlite-maintenance",
      schedules: [{ every: 6 * HOUR_MS }, { dailyAt: { hour: 3, minute: 0 } }],
      run: (job) => {
        runs.push((job.startedAt - MIDNIGHT) / HOUR_MS);
        return Promise.resolve();
      },
    });
    scheduler.start();
    await timers.advance(DAY_MS);
    assert.deepEqual(runs, [3, 6, 12, 18, 24]);
    await scheduler.stop();
  });

  test("runNow runs outside the schedule; names and schedules are checked", async () => {
    const { scheduler } = setup();
    let runs = 0;
    scheduler.add({
      name: "disk-guard",
      schedules: [{ every: MINUTE_MS }],
      run: () => {
        runs += 1;
        return Promise.resolve();
      },
    });
    assert.equal(await scheduler.runNow("disk-guard"), "done");
    assert.equal(runs, 1);
    await assert.rejects(scheduler.runNow("nope"), SchedulerError);
    assert.throws(() => {
      scheduler.add({ name: "disk-guard", schedules: [{ every: MINUTE_MS }], run: () => Promise.resolve() });
    }, SchedulerError);
    assert.throws(() => {
      scheduler.add({ name: "Bad Name", schedules: [{ every: MINUTE_MS }], run: () => Promise.resolve() });
    }, SchedulerError);
    assert.throws(() => {
      scheduler.add({ name: "too-often", schedules: [{ every: 10 }], run: () => Promise.resolve() });
    }, SchedulerError);
    assert.throws(() => {
      scheduler.add({ name: "no-schedule", schedules: [], run: () => Promise.resolve() });
    }, SchedulerError);
    assert.throws(() => {
      scheduler.add({
        name: "bad-time",
        schedules: [{ dailyAt: { hour: 24, minute: 0 } }],
        run: () => Promise.resolve(),
      });
    }, SchedulerError);
    assert.deepEqual(scheduler.names(), ["disk-guard"]);
    await scheduler.stop();
  });
});
