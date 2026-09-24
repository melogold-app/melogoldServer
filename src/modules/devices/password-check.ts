/**
 * Password verification for reauth (DESIGN §4.1): NFKC, then argon2id `verify` under the semaphore of
 * `ARGON2_MAX_CONCURRENCY` permits and a queue of `ARGON2_QUEUE_LIMIT` (a full queue rejects with
 * `SemaphoreFullError`, which the error handler answers with `503 server_busy{5}`).
 *
 * Never call it inside a database transaction (docs/database.md §2.3).
 *
 * The semaphore is one per application context (`ctx.env` is created once per context and never replaced).
 */
import { verify } from "argon2";
import type { Env } from "../../config/env.ts";
import { Semaphore } from "../../lib/semaphore.ts";

export type PasswordCheckContext = Readonly<{
  env: Pick<Env, "ARGON2_MAX_CONCURRENCY" | "ARGON2_QUEUE_LIMIT">;
  log: Readonly<{ warn(details: object, message: string): void }>;
}>;

const semaphores = new WeakMap<object, Semaphore>();

function semaphoreOf(env: PasswordCheckContext["env"]): Semaphore {
  let semaphore = semaphores.get(env);
  if (!semaphore) {
    semaphore = new Semaphore({ concurrency: env.ARGON2_MAX_CONCURRENCY, queueLimit: env.ARGON2_QUEUE_LIMIT });
    semaphores.set(env, semaphore);
  }
  return semaphore;
}

/**
 * Whether `password` (NFKC-normalized) matches the stored PHC `passwordHash`. A hash that argon2 cannot parse (the
 * `'!'` of a deleted account, a corrupted value) never matches and is logged.
 * @throws SemaphoreFullError when the argon2 queue is full.
 */
export async function checkPassword(
  ctx: PasswordCheckContext,
  passwordHash: string,
  password: string,
): Promise<boolean> {
  const normalized = password.normalize("NFKC");
  return semaphoreOf(ctx.env).run(async () => {
    try {
      return await verify(passwordHash, normalized);
    } catch (error) {
      ctx.log.warn({ err: error }, "stored password hash is not a valid argon2 hash");
      return false;
    }
  });
}
