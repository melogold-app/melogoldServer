/**
 * argon2id under a semaphore (DESIGN §4.1): every hash and every verification of the process — login, register,
 * recover, password change, reauth — shares `ARGON2_MAX_CONCURRENCY` permits with a queue of `ARGON2_QUEUE_LIMIT`.
 * A full queue rejects with `SemaphoreFullError`, which the error handler answers `503 server_busy` with
 * `retryAfterSeconds: 5`.
 *
 * - Passwords are NFKC-normalized here, before hashing and before verification (API §1.6), so no caller can forget.
 * - {@link Argon2Pool.verifyDummy} costs what a real verification costs (a hash made once with the current parameters),
 *   so an unknown login answers like a wrong password (C/modules/auth/security.service.ts:147-163).
 * - {@link Argon2Pool.needsRehash} tells after a successful verification that the stored hash has other parameters.
 * - argon2 never runs inside a database transaction (docs/database.md §2.3): hash first, then `db.write`.
 *
 * One pool per application context ({@link argon2PoolFor}), so the modules that verify passwords (auth, devices,
 * account) share the semaphore.
 */
import { randomBytes } from "node:crypto";
import { argon2id, hash, needsRehash, verify } from "argon2";
import type { Env } from "../../config/env.ts";
import { Semaphore } from "../../lib/semaphore.ts";
import { normalizePassword } from "./password.ts";

export type Argon2Params = Readonly<{
  /** `ARGON2_MEMORY_KIB`. */
  memoryKiB: number;
  /** `ARGON2_TIME_COST`. */
  timeCost: number;
  /** `ARGON2_PARALLELISM`. */
  parallelism: number;
}>;

export type Argon2PoolOptions = Argon2Params &
  Readonly<{
    /** `ARGON2_MAX_CONCURRENCY`. */
    maxConcurrency: number;
    /** `ARGON2_QUEUE_LIMIT`. */
    queueLimit: number;
  }>;

export function argon2Options(
  env: Pick<
    Env,
    "ARGON2_MEMORY_KIB" | "ARGON2_TIME_COST" | "ARGON2_PARALLELISM" | "ARGON2_MAX_CONCURRENCY" | "ARGON2_QUEUE_LIMIT"
  >,
): Argon2PoolOptions {
  return Object.freeze({
    memoryKiB: env.ARGON2_MEMORY_KIB,
    timeCost: env.ARGON2_TIME_COST,
    parallelism: env.ARGON2_PARALLELISM,
    maxConcurrency: env.ARGON2_MAX_CONCURRENCY,
    queueLimit: env.ARGON2_QUEUE_LIMIT,
  });
}

/** Operations done so far (tests compare the work of different paths). */
export type Argon2Stats = Readonly<{ hashes: number; verifies: number }>;

export class Argon2Pool {
  readonly params: Argon2Params;
  readonly #semaphore: Semaphore;
  #dummyHash: Promise<string> | null = null;
  #hashes = 0;
  #verifies = 0;

  constructor(options: Argon2PoolOptions) {
    this.params = Object.freeze({
      memoryKiB: options.memoryKiB,
      timeCost: options.timeCost,
      parallelism: options.parallelism,
    });
    this.#semaphore = new Semaphore({ concurrency: options.maxConcurrency, queueLimit: options.queueLimit });
  }

  get stats(): Argon2Stats {
    return { hashes: this.#hashes, verifies: this.#verifies };
  }

  /** Permits in use and callers waiting (tests, diagnostics). */
  get load(): Readonly<{ active: number; queued: number }> {
    return { active: this.#semaphore.active, queued: this.#semaphore.queued };
  }

  /**
   * A PHC string of argon2id with the current parameters.
   * @throws SemaphoreFullError when the queue is full.
   */
  hash(password: string): Promise<string> {
    return this.#semaphore.run(() => {
      this.#hashes += 1;
      return this.#rawHash(normalizePassword(password));
    });
  }

  /**
   * Whether `password` matches the stored hash. A malformed hash (`'!'` of a deleted account) never matches.
   * @throws SemaphoreFullError when the queue is full.
   */
  verify(storedHash: string, password: string): Promise<boolean> {
    return this.#semaphore.run(() => {
      this.#verifies += 1;
      return this.#rawVerify(storedHash, normalizePassword(password));
    });
  }

  /**
   * A verification that always fails, at the cost of a real one (unknown login).
   * @throws SemaphoreFullError when the queue is full.
   */
  async verifyDummy(password: string): Promise<false> {
    const dummy = await this.#dummy();
    await this.#semaphore.run(() => {
      this.#verifies += 1;
      return this.#rawVerify(dummy, normalizePassword(password));
    });
    return false;
  }

  /** Whether a hash that just verified should be replaced by one with the current parameters. */
  needsRehash(storedHash: string): boolean {
    try {
      return needsRehash(storedHash, {
        memoryCost: this.params.memoryKiB,
        timeCost: this.params.timeCost,
        parallelism: this.params.parallelism,
      });
    } catch {
      return true;
    }
  }

  #rawHash(password: string): Promise<string> {
    return hash(password, {
      type: argon2id,
      memoryCost: this.params.memoryKiB,
      timeCost: this.params.timeCost,
      parallelism: this.params.parallelism,
    });
  }

  async #rawVerify(storedHash: string, password: string): Promise<boolean> {
    try {
      return await verify(storedHash, password);
    } catch {
      return false;
    }
  }

  #dummy(): Promise<string> {
    if (this.#dummyHash === null) {
      const pending = this.#semaphore.run(() => this.#rawHash(randomBytes(24).toString("base64url")));
      pending.catch(() => {
        if (this.#dummyHash === pending) this.#dummyHash = null;
      });
      this.#dummyHash = pending;
    }
    return this.#dummyHash;
  }
}

const pools = new WeakMap<object, Argon2Pool>();

/**
 * The pool of an application context, created on first use. Every module passes the same `ctx`, so they share one
 * semaphore.
 */
export function argon2PoolFor(ctx: Readonly<{ env: Parameters<typeof argon2Options>[0] }>): Argon2Pool {
  let pool = pools.get(ctx);
  if (pool === undefined) {
    pool = new Argon2Pool(argon2Options(ctx.env));
    pools.set(ctx, pool);
  }
  return pool;
}
