/**
 * Issuing sessions (API §1.7, §4.1 `TokenPair`; DESIGN §4.3–4.4). Frozen after M0 (PLAN, general rules, item 2).
 *
 * A session is a `devices` row plus its refresh token family. {@link issueSession} runs **inside the `db.write`** that
 * creates or reuses the device (register, login, recover, link completion, refresh rotation): it inserts a
 * `refresh_tokens` row and returns the token pair whose access token carries `rid = refresh_tokens.id`.
 *
 * The refresh token is deterministic ({@link signRefreshToken}); the database keeps only `sha256(token)`.
 * {@link tokensForRefreshRow} re-signs the pair of an existing row: the refresh grace window (DESIGN §4.4) and the
 * repeated link poll (DESIGN §4.10.6, m3) return the same refresh token again.
 */
import type { Env } from "../config/env.ts";
import type { Subkeys } from "../config/secret-key.ts";
import type { Queryable } from "../db/index.ts";
import { TxRuleError, currentTxScope } from "../db/tx.ts";
import { DAY_MS } from "./clock.ts";
import { newId } from "./ids.ts";
import { formatIso } from "./time.ts";
import { hashToken, signAccessToken, signRefreshToken } from "./tokens.ts";
import type { RefreshTokenRowKey } from "./tokens.ts";

export type SessionConfig = Readonly<{
  /** HKDF subkey `melogold/jwt-access/v1`. */
  accessKey: Uint8Array;
  /** HKDF subkey `melogold/refresh-token/v1`. */
  refreshKey: Uint8Array;
  /** `ACCESS_TOKEN_TTL_SECONDS`. */
  accessTokenTtlSeconds: number;
  /** `REFRESH_TOKEN_TTL_DAYS`: sliding, counted from every rotation. */
  refreshTokenTtlDays: number;
}>;

export function sessionConfig(
  env: Pick<Env, "ACCESS_TOKEN_TTL_SECONDS" | "REFRESH_TOKEN_TTL_DAYS">,
  keys: Pick<Subkeys, "jwtAccess" | "refreshToken">,
): SessionConfig {
  return Object.freeze({
    accessKey: keys.jwtAccess,
    refreshKey: keys.refreshToken,
    accessTokenTtlSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
  });
}

/** API §4.1 `TokenPair` (times as API §1.5 strings). */
export type TokenPair = Readonly<{
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}>;

export type IssuedSession = Readonly<{
  /** `refresh_tokens.id` = the access token's `rid` (link completion stores it as `result_refresh_id`). */
  refreshId: string;
  tokens: TokenPair;
  /** Epoch milliseconds of `tokens.accessTokenExpiresAt` (SSE closes the stream then, DESIGN §4.7). */
  accessTokenExpiresAtMs: number;
  /** Epoch milliseconds of `tokens.refreshTokenExpiresAt` (= `refresh_tokens.expires_at`). */
  refreshTokenExpiresAtMs: number;
}>;

export type IssueSessionInput = Readonly<{
  userId: string;
  deviceId: string;
  /** `users.auth_version` read in the same transaction; goes into the access token as `av`. */
  authVersion: number;
  /** Epoch milliseconds (`ctx.clock.now()`). */
  now: number;
  /**
   * Delete the device's existing refresh tokens first: login with an already known `(user, hwid)` reuses the device
   * row and starts a new token family (DESIGN §4.6).
   */
  replaceDeviceTokens?: boolean;
  /**
   * Id of the new `refresh_tokens` row when the caller needs it before the insert (refresh rotation writes
   * `rotated_to_id` of the old row first). Default: a new UUID v4.
   */
  refreshId?: string;
}>;

/**
 * Creates a refresh token row for the device and returns the new token pair. Must run inside `db.write`, in the
 * transaction that created or checked the device.
 * @throws TxRuleError outside `db.write`.
 */
export async function issueSession(
  q: Queryable,
  input: IssueSessionInput,
  config: SessionConfig,
): Promise<IssuedSession> {
  if (currentTxScope()?.kind !== "write") throw new TxRuleError("issueSession must be called inside db.write");
  if (input.replaceDeviceTokens === true) {
    await q.deleteFrom("refresh_tokens").where("device_id", "=", input.deviceId).execute();
  }
  const row = {
    id: input.refreshId ?? newId(),
    user_id: input.userId,
    device_id: input.deviceId,
    expires_at: input.now + config.refreshTokenTtlDays * DAY_MS,
  };
  const refreshToken = signRefreshToken(refreshInput(row), config.refreshKey);
  await q
    .insertInto("refresh_tokens")
    .values({
      ...row,
      token_hash: hashToken(refreshToken),
      rotated_to_id: null,
      rotation_grace_expires_at: null,
      revoked_at: null,
      confirmed_at: null,
      created_at: input.now,
    })
    .execute();
  return buildSession(row, refreshToken, input.authVersion, config, input.now);
}

/**
 * The token pair of an existing `refresh_tokens` row: the same refresh token string as when the row was issued, and
 * a new access token with `rid = row.id`. No database access.
 * @param authVersion current `users.auth_version`.
 * @param now epoch milliseconds.
 */
export function tokensForRefreshRow(
  row: RefreshTokenRowKey,
  authVersion: number,
  config: SessionConfig,
  now: number,
): IssuedSession {
  const refreshToken = signRefreshToken(refreshInput(row), config.refreshKey);
  return buildSession(row, refreshToken, authVersion, config, now);
}

function refreshInput(row: RefreshTokenRowKey) {
  return { tid: row.id, sub: row.user_id, did: row.device_id, expiresAt: row.expires_at };
}

function buildSession(
  row: RefreshTokenRowKey,
  refreshToken: string,
  authVersion: number,
  config: SessionConfig,
  now: number,
): IssuedSession {
  const access = signAccessToken(
    { sub: row.user_id, did: row.device_id, av: authVersion, rid: row.id },
    config.accessKey,
    {
      now,
      ttlSeconds: config.accessTokenTtlSeconds,
    },
  );
  return Object.freeze({
    refreshId: row.id,
    tokens: Object.freeze({
      accessToken: access.token,
      accessTokenExpiresAt: formatIso(access.expiresAt),
      refreshToken,
      refreshTokenExpiresAt: formatIso(row.expires_at),
    }),
    accessTokenExpiresAtMs: access.expiresAt,
    refreshTokenExpiresAtMs: row.expires_at,
  });
}
