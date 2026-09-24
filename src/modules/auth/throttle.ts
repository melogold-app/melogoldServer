/**
 * Failed-attempt throttling in the database (`auth_throttle`, API §5, DESIGN §4.1):
 *
 * | scope    | key             | window | free failures | lock after failure n                  | refusal                 |
 * | -------- | --------------- | ------ | ------------- | ------------------------------------- | ----------------------- |
 * | `login`  | normalized login | 15 min | 5             | `min(30 s · 2^(n−6), 15 min)` for n ≥ 6 | `429 login_throttled`   |
 * | `reauth` | user id         | 15 min | 4             | 15 min for n ≥ 5                      | `429 reauth_throttled`  |
 *
 * - The row key is `sha256(scope + ":" + key)`: no login or id is stored in clear.
 * - A failure is counted atomically ({@link countFailure}); a window that is over and not locked starts again.
 * - A success deletes the row ({@link clearThrottle}).
 * - A locked key is refused **before** argon2 runs. For `login`, a device the account already knows (`sha256(hwid)`
 *   of one of its devices) is not refused: an attacker cannot lock the owner out (DESIGN §9).
 * - Unknown logins are counted like known ones, so the answers never tell them apart.
 */
import type { Queryable } from "../../db/index.ts";
import { AppError } from "../../http/errors.ts";
import { MINUTE_MS, SECOND_MS } from "../../lib/clock.ts";
import { sha256Hex } from "../../lib/crypto.ts";
import { countThrottleFailure, deleteThrottle, findThrottle, lockThrottle } from "./auth.repository.ts";

export type ThrottleScope = "login" | "reauth";

export type ThrottlePolicy = Readonly<{
  scope: ThrottleScope;
  /** Failures are counted within this window from the first one. */
  windowMs: number;
  /** How long the key is locked after the `failures`-th failure of the window (0: not locked). */
  lockMs(failures: number): number;
  /** The refusal while locked. */
  refusal: "login_throttled" | "reauth_throttled";
}>;

export const THROTTLE_WINDOW_MS = 15 * MINUTE_MS;
export const THROTTLE_MAX_LOCK_MS = 15 * MINUTE_MS;

/** `auth_throttle(login)`: 5 free failures, then `min(30 s · 2^(n−6), 15 min)`. */
export const LOGIN_THROTTLE: ThrottlePolicy = Object.freeze({
  scope: "login",
  windowMs: THROTTLE_WINDOW_MS,
  lockMs: (failures: number) =>
    failures < 6 ? 0 : Math.min(30 * SECOND_MS * 2 ** Math.min(failures - 6, 16), THROTTLE_MAX_LOCK_MS),
  refusal: "login_throttled",
});

/** `auth_throttle(reauth, userId)`: 5 failures → 15 minutes. */
export const REAUTH_THROTTLE: ThrottlePolicy = Object.freeze({
  scope: "reauth",
  windowMs: THROTTLE_WINDOW_MS,
  lockMs: (failures: number) => (failures < 5 ? 0 : THROTTLE_MAX_LOCK_MS),
  refusal: "reauth_throttled",
});

/** `auth_throttle.key_hash`. */
export function throttleKeyHash(scope: ThrottleScope, key: string): string {
  return sha256Hex(`${scope}:${key}`);
}

/** `retryAfterSeconds` of a lock: whole seconds, at least 1. */
export function retryAfterSeconds(lockedUntil: number, now: number): number {
  return Math.max(1, Math.ceil((lockedUntil - now) / SECOND_MS));
}

/** The refusal of a locked key. */
export function throttledError(policy: ThrottlePolicy, lockedUntil: number, now: number): AppError {
  const details = { retryAfterSeconds: retryAfterSeconds(lockedUntil, now) };
  return policy.refusal === "login_throttled"
    ? new AppError("login_throttled", { details })
    : new AppError("reauth_throttled", { details });
}

/**
 * The end of the current lock of a key, or `null` when it is not locked (read before argon2).
 */
export async function lockedUntil(
  q: Queryable,
  policy: ThrottlePolicy,
  key: string,
  now: number,
): Promise<number | null> {
  const row = await findThrottle(q, policy.scope, throttleKeyHash(policy.scope, key));
  const until = row?.locked_until ?? null;
  return until !== null && until > now ? until : null;
}

/**
 * Counts a failure inside the caller's `db.write` and locks the key when the policy says so.
 * @returns the end of the lock this failure started (or extended), or `null` when the key stays unlocked.
 */
export async function countFailure(
  q: Queryable,
  policy: ThrottlePolicy,
  key: string,
  now: number,
): Promise<number | null> {
  const keyHash = throttleKeyHash(policy.scope, key);
  const counted = await countThrottleFailure(q, policy.scope, keyHash, now, policy.windowMs);
  const lockMs = policy.lockMs(counted.failures);
  if (lockMs <= 0) return null;
  const until = Math.max(now + lockMs, counted.lockedUntil ?? 0);
  await lockThrottle(q, policy.scope, keyHash, counted.failures, until);
  return until;
}

/** A success: the key's row is deleted (inside the caller's transaction). */
export async function clearThrottle(q: Queryable, policy: ThrottlePolicy, key: string): Promise<void> {
  await deleteThrottle(q, policy.scope, throttleKeyHash(policy.scope, key));
}
