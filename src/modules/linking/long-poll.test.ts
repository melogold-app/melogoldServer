/**
 * The in-memory long-poll of `POST /auth/link/poll` (DESIGN §4.10.6): wake, timeout, abort, shutdown, bookkeeping.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LinkWaiters } from "./long-poll.ts";
import type { WaitTimers } from "./long-poll.ts";

/** Timers that fire only when the test says so. */
function manualTimers() {
  const pending = new Map<number, { callback: () => void; ms: number }>();
  let next = 0;
  const timers: WaitTimers = {
    setTimeout: (callback, ms) => {
      next += 1;
      pending.set(next, { callback, ms });
      return next;
    },
    clearTimeout: (handle) => {
      pending.delete(handle as number);
    },
  };
  return {
    timers,
    pending,
    fireAll: () => {
      for (const [handle, timer] of [...pending]) {
        pending.delete(handle);
        timer.callback();
      }
    },
  };
}

const LINK = "5b0e7c1a-2d3e-4f5a-8b6c-7d8e9f0a1b2c";
const OTHER = "a91c0b2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";

describe("LinkWaiters", () => {
  test("wake ends every wait of the link, and only of that link", async () => {
    const { timers, pending } = manualTimers();
    const waiters = new LinkWaiters({ timers });
    const first = waiters.wait(LINK, 25_000);
    const second = waiters.wait(LINK, 25_000);
    const other = waiters.wait(OTHER, 25_000);
    assert.equal(waiters.count(LINK), 2);
    assert.equal(waiters.count(), 3);
    assert.equal(waiters.wake(LINK), 2);
    assert.deepEqual(await Promise.all([first, second]), ["woken", "woken"]);
    assert.equal(waiters.count(LINK), 0);
    assert.equal(waiters.count(), 1);
    assert.equal(pending.size, 1, "the timers of woken waits are cleared");
    assert.equal(waiters.wake(LINK), 0);
    waiters.close();
    assert.equal(await other, "closed");
  });

  test("a wait times out after its milliseconds", async () => {
    const { timers, pending, fireAll } = manualTimers();
    const waiters = new LinkWaiters({ timers });
    const waiting = waiters.wait(LINK, 1234);
    assert.deepEqual(
      [...pending.values()].map((timer) => timer.ms),
      [1234],
    );
    fireAll();
    assert.equal(await waiting, "timeout");
    assert.equal(waiters.count(), 0);
  });

  test("zero, negative or NaN milliseconds do not wait", async () => {
    const waiters = new LinkWaiters();
    assert.equal(await waiters.wait(LINK, 0), "timeout");
    assert.equal(await waiters.wait(LINK, -5), "timeout");
    assert.equal(await waiters.wait(LINK, Number.NaN), "timeout");
    assert.equal(waiters.count(), 0);
  });

  test("an abort signal ends the wait; an aborted signal does not wait at all", async () => {
    const { timers, pending } = manualTimers();
    const waiters = new LinkWaiters({ timers });
    const controller = new AbortController();
    const waiting = waiters.wait(LINK, 25_000, controller.signal);
    controller.abort();
    assert.equal(await waiting, "aborted");
    assert.equal(pending.size, 0);
    assert.equal(await waiters.wait(LINK, 25_000, controller.signal), "aborted");
    assert.equal(waiters.count(), 0);
  });

  test("close wakes everybody with closed, and later waits return at once", async () => {
    const waiters = new LinkWaiters();
    const waiting = [waiters.wait(LINK, 60_000), waiters.wait(OTHER, 60_000)];
    assert.equal(waiters.closed, false);
    waiters.close();
    assert.equal(waiters.closed, true);
    assert.deepEqual(await Promise.all(waiting), ["closed", "closed"]);
    assert.equal(await waiters.wait(LINK, 60_000), "closed");
    waiters.close();
    assert.equal(waiters.count(), 0);
  });

  test("real timers: a short wait ends by itself", async () => {
    const waiters = new LinkWaiters();
    const started = performance.now();
    assert.equal(await waiters.wait(LINK, 20), "timeout");
    assert.ok(performance.now() - started >= 15);
  });
});
