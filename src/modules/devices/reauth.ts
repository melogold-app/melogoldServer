/**
 * Reauth: the password check of sensitive actions (DESIGN §4.1, §4.8; API §2.2, §5), and the enforcement of a
 * {@link Gate} of `src/modules/security/policy.ts`.
 *
 * - Throttle row `auth_throttle(scope = 'reauth', key_hash = sha256("reauth:" + userId))`.
 * - While `locked_until > now`: `429 reauth_throttled{retryAfterSeconds}` **without** calling argon2.
 * - A wrong password: `403 invalid_password` and one failure counted. Failures live in a window of 15 min from the
 *   first one; the 5th failure of a window locks the key for 15 min, so the next attempt answers `429`.
 * - A right password deletes the row.
 * - argon2 runs outside every transaction, under the argon2 semaphore (`password-check.ts`).
 *
 * Used by the devices routes (rename, revoke, revoke-others) and meant for the other password-gated actions of
 * DESIGN §4.8 (`me/password` with the old password, `me/recovery-code`, `me/delete`): they call {@link passGate}
 * with the gate of `policy.ts`, or {@link verifyReauth} directly.
 */
import type { AppContext } from "../../context.ts";
import { AppError } from "../../http/errors.ts";
import { MINUTE_MS } from "../../lib/clock.ts";
import { sha256Hex } from "../../lib/crypto.ts";
import type { Gate } from "../security/policy.ts";
import {
  clearReauthThrottle,
  findPasswordHash,
  readReauthThrottle,
  recordReauthFailure,
} from "./devices.repository.ts";
import { checkPassword } from "./password-check.ts";

/** DESIGN §4.1: 5 failures → 15 min. */
export const REAUTH_MAX_FAILURES = 5;
export const REAUTH_WINDOW_MS = 15 * MINUTE_MS;
export const REAUTH_LOCK_MS = 15 * MINUTE_MS;

export type ReauthContext = Pick<AppContext, "db" | "clock" | "env" | "log">;

/** `auth_throttle.key_hash` of a user's reauth row: `sha256(scope + ":" + key)` (API §9.2). */
export function reauthKeyHash(userId: string): string {
  return sha256Hex(`reauth:${userId}`);
}

/** Whole seconds until `lockedUntil`, at least 1 (API §2.2 `retryAfterSeconds`). */
export function retryAfterSeconds(lockedUntil: number, now: number): number {
  return Math.max(1, Math.ceil((lockedUntil - now) / 1000));
}

function throttled(lockedUntil: number, now: number): AppError<"reauth_throttled"> {
  return new AppError("reauth_throttled", { details: { retryAfterSeconds: retryAfterSeconds(lockedUntil, now) } });
}

/**
 * Checks the user's password for a sensitive action.
 * @throws AppError `reauth_throttled` (locked), `invalid_password` (wrong), `session_revoked` (the user is gone);
 *   `SemaphoreFullError` when the argon2 queue is full (`503 server_busy`).
 */
export async function verifyReauth(ctx: ReauthContext, userId: string, password: string): Promise<void> {
  const keyHash = reauthKeyHash(userId);
  const before = ctx.clock.now();
  const state = await ctx.db.run((q) => readReauthThrottle(q, keyHash));
  const lockedUntil = state?.lockedUntil ?? null;
  if (lockedUntil !== null && lockedUntil > before) throw throttled(lockedUntil, before);

  const passwordHash = await ctx.db.run((q) => findPasswordHash(q, userId));
  if (passwordHash === undefined) throw new AppError("session_revoked");

  if (await checkPassword(ctx, passwordHash, password)) {
    if (state !== undefined) await ctx.db.run((q) => clearReauthThrottle(q, keyHash));
    return;
  }
  const now = ctx.clock.now();
  await ctx.db.run((q) =>
    recordReauthFailure(q, keyHash, {
      now,
      windowMs: REAUTH_WINDOW_MS,
      maxFailures: REAUTH_MAX_FAILURES,
      lockMs: REAUTH_LOCK_MS,
    }),
  );
  throw new AppError("invalid_password");
}

/**
 * Applies a gate of the DESIGN §4.8 matrix before the action's transaction.
 * @returns whether the password was verified (the transaction re-checks the gate with it, {@link recheckGate}).
 * @throws AppError the gate's refusal code, or those of {@link verifyReauth}.
 */
export async function passGate(ctx: ReauthContext, userId: string, gate: Gate): Promise<boolean> {
  switch (gate.outcome) {
    case "allow":
      return false;
    case "refuse":
      throw new AppError(gate.code);
    case "verify_password":
      await verifyReauth(ctx, userId, gate.password);
      return true;
  }
}

/**
 * Re-applies the gate inside the action's transaction, on the rows the transaction sees: a refusal throws (the
 * transaction rolls back), and a gate that now asks for the password passes only if {@link passGate} verified it.
 */
export function recheckGate(gate: Gate, passwordVerified: boolean): void {
  switch (gate.outcome) {
    case "allow":
      return;
    case "refuse":
      throw new AppError(gate.code);
    case "verify_password":
      if (!passwordVerified) throw new AppError("recent_device_restricted");
      return;
  }
}
