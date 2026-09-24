/** The argon2 pool (DESIGN §4.1): argon2id, NFKC, dummy verification, needsRehash, the semaphore. */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SemaphoreFullError } from "../../lib/semaphore.ts";
import { Argon2Pool, argon2PoolFor } from "./argon2-pool.ts";

const FAST = { memoryKiB: 19_456, timeCost: 2, parallelism: 1 } as const;

describe("Argon2Pool", () => {
  test("argon2id PHC with the configured parameters; verify; NFKC on both sides", async () => {
    const pool = new Argon2Pool({ ...FAST, maxConcurrency: 2, queueLimit: 8 });
    const hash = await pool.hash("мой йорк");
    // The installed `argon2` package (node-argon2 0.45) orders PHC parameters m,p,t, not the RFC 9106 m,t,p.
    assert.match(hash, /^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
    assert.equal(await pool.verify(hash, "мой йорк"), true, "composed «й» matches the decomposed one");
    assert.equal(await pool.verify(hash, "мой иорк"), false);
    assert.equal(await pool.verify("!", "anything"), false, "a malformed hash never matches");
    assert.equal(pool.needsRehash(hash), false);
    assert.deepEqual(pool.stats, { hashes: 1, verifies: 3 });
  });

  test("needsRehash when the parameters changed", async () => {
    const old = new Argon2Pool({ ...FAST, maxConcurrency: 1, queueLimit: 1 });
    const stronger = new Argon2Pool({ ...FAST, timeCost: 3, maxConcurrency: 1, queueLimit: 1 });
    const hash = await old.hash("две собаки и кот");
    assert.equal(stronger.needsRehash(hash), true);
    assert.equal(stronger.needsRehash("!"), true);
    assert.equal(await stronger.verify(hash, "две собаки и кот"), true, "old hashes still verify");
  });

  test("verifyDummy costs one verification and always fails", async () => {
    const pool = new Argon2Pool({ ...FAST, maxConcurrency: 1, queueLimit: 4 });
    assert.equal(await pool.verifyDummy("x"), false);
    assert.equal(await pool.verifyDummy("y"), false);
    assert.deepEqual(pool.stats, { hashes: 0, verifies: 2 });
  });

  test("a full queue rejects with SemaphoreFullError (503 server_busy)", async () => {
    const pool = new Argon2Pool({ ...FAST, maxConcurrency: 1, queueLimit: 1 });
    const running = pool.hash("a");
    const queued = pool.hash("b");
    await assert.rejects(pool.hash("c"), SemaphoreFullError);
    await Promise.all([running, queued]);
    assert.deepEqual(pool.load, { active: 0, queued: 0 });
  });

  test("argon2PoolFor: one pool per context", () => {
    const env = {
      ARGON2_MEMORY_KIB: 19_456,
      ARGON2_TIME_COST: 2,
      ARGON2_PARALLELISM: 1,
      ARGON2_MAX_CONCURRENCY: 2,
      ARGON2_QUEUE_LIMIT: 32,
    };
    const a = { env };
    const b = { env };
    assert.equal(argon2PoolFor(a), argon2PoolFor(a));
    assert.notEqual(argon2PoolFor(a), argon2PoolFor(b));
  });
});
