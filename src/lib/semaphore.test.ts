import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Semaphore, SemaphoreFullError } from "./semaphore.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("Semaphore", () => {
  test("validates options", () => {
    assert.throws(() => new Semaphore({ concurrency: 0, queueLimit: 1 }), RangeError);
    assert.throws(() => new Semaphore({ concurrency: 1.5, queueLimit: 1 }), RangeError);
    assert.throws(() => new Semaphore({ concurrency: 1, queueLimit: -1 }), RangeError);
  });

  test("at most `concurrency` holders, FIFO hand-over", async () => {
    const semaphore = new Semaphore({ concurrency: 2, queueLimit: 10 });
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    const gates = Array.from({ length: 6 }, () => deferred());
    const runs = gates.map((gate, index) =>
      semaphore.run(async () => {
        running += 1;
        peak = Math.max(peak, running);
        order.push(index);
        await gate.promise;
        running -= 1;
        return index;
      }),
    );
    await tick();
    assert.equal(semaphore.active, 2);
    assert.equal(semaphore.queued, 4);
    for (const gate of gates) {
      gate.resolve();
      await tick();
    }
    assert.deepEqual(await Promise.all(runs), [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(order, [0, 1, 2, 3, 4, 5]);
    assert.equal(peak, 2);
    assert.equal(semaphore.active, 0);
    assert.equal(semaphore.queued, 0);
  });

  test("a full queue rejects with SemaphoreFullError (argon2 → 503 server_busy)", async () => {
    const semaphore = new Semaphore({ concurrency: 1, queueLimit: 1 });
    const release = await semaphore.acquire();
    const waiting = semaphore.acquire();
    await assert.rejects(semaphore.acquire(), SemaphoreFullError);
    release();
    const second = await waiting;
    assert.equal(semaphore.active, 1);
    second();
    assert.equal(semaphore.active, 0);
  });

  test("release is idempotent", async () => {
    const semaphore = new Semaphore({ concurrency: 1, queueLimit: 0 });
    const release = await semaphore.acquire();
    release();
    release();
    assert.equal(semaphore.active, 0);
    const again = await semaphore.acquire();
    assert.equal(semaphore.active, 1);
    again();
  });

  test("run releases when fn throws", async () => {
    const semaphore = new Semaphore({ concurrency: 1, queueLimit: 0 });
    await assert.rejects(
      semaphore.run(() => {
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.equal(semaphore.active, 0);
  });

  test("an aborted waiter leaves the queue", async () => {
    const semaphore = new Semaphore({ concurrency: 1, queueLimit: 2 });
    const release = await semaphore.acquire();
    const controller = new AbortController();
    const aborted = semaphore.acquire(controller.signal);
    const next = semaphore.acquire();
    assert.equal(semaphore.queued, 2);
    controller.abort(new Error("gone"));
    await assert.rejects(aborted, /gone/);
    assert.equal(semaphore.queued, 1);
    release();
    const nextRelease = await next;
    nextRelease();
    assert.equal(semaphore.active, 0);
    await assert.rejects(semaphore.acquire(AbortSignal.abort(new Error("early"))), /early/);
  });
});
