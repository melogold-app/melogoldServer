/**
 * Refresh rotation and logout (API §1.7, §4.3; DESIGN §4.4, §4.5, §3.15 item 5).
 *
 * **Refresh** (`POST /auth/refresh`), one `db.write` without `lockUser` (CAS on the token row, API §9.5):
 * 1. the token must be an authentic, unexpired `mgrt1` token → else `401 invalid_refresh_token`;
 * 2. no row with its `tid`: inside the restore grace window (`server_meta.restore_refresh_grace_until`) a token of an
 *    existing device `(did, sub)` starts a new token family (the device's old rows are deleted); otherwise
 *    `401 session_revoked`;
 * 3. the row must describe the token and `token_hash` must match → else `invalid_refresh_token`;
 * 4. `sha256(device.hwid)` must be the device's → else `401 device_mismatch` (nothing is removed);
 * 5. a current token (not rotated, not revoked, not expired) is rotated by CAS
 *    (`UPDATE … SET rotated_to_id … WHERE rotated_to_id IS NULL AND revoked_at IS NULL`); the winner inserts the
 *    successor with a new expiry (sliding TTL) and reports the device metadata;
 * 6. a rotated token within `REFRESH_GRACE_SECONDS`: if its successor was never used (`confirmed_at IS NULL`, the
 *    guard sets it on the first access with `rid = successor`) and is still current, the **same** successor is
 *    returned again (the answer was lost); otherwise the token was stolen or replayed:
 *    `removeDevicesInTx(…, "token_reuse")` → `401 refresh_token_reused`;
 * 7. anything else (rotated beyond the grace window, revoked) → `invalid_refresh_token`.
 *
 * After commit: a reuse removal publishes its live effects (`session.invalidated{token_reuse}` → close →
 * `devices.updated`), then the request fails.
 *
 * **Logout** (`POST /auth/logout`) always succeeds (204). The token is authenticated by HMAC without its expiry; the
 * device is removed only when the row exists, matches, and the token is current or within its grace window (M4: an
 * old token cannot sign anybody out). After commit: `closeDevice`, `devices.updated{device_signed_out}` to the others.
 */
import type { AppContext } from "../../context.ts";
import type { LogoutRequest, RefreshRequest, RefreshResponse } from "../../contract/auth.ts";
import type { DevicePatch } from "../../contract/common.ts";
import type { Queryable } from "../../db/index.ts";
import { AppError } from "../../http/errors.ts";
import { SECOND_MS } from "../../lib/clock.ts";
import { constantTimeEqual } from "../../lib/crypto.ts";
import { removeDevicesInTx } from "../../lib/device-removal.ts";
import type { RemovedDevices } from "../../lib/device-removal.ts";
import { newId } from "../../lib/ids.ts";
import { issueSession, sessionConfig, tokensForRefreshRow } from "../../lib/session.ts";
import type { IssuedSession } from "../../lib/session.ts";
import { formatIso } from "../../lib/time.ts";
import { hashToken, isRefreshTokenExpired, parseRefreshToken, refreshTokenMatchesRow } from "../../lib/tokens.ts";
import type { RefreshTokenPayload } from "../../lib/tokens.ts";
import {
  findDevice,
  findRefreshToken,
  findUser,
  markRotated,
  readRestoreGraceUntil,
  updateDeviceReport,
} from "./auth.repository.ts";
import type { DeviceRow, RefreshTokenRow, UserRow } from "./auth.repository.ts";
import { toDeviceDto } from "./dto.ts";
import { hwidHash } from "./hwid.ts";

export type RefreshFailure = "invalid_refresh_token" | "session_revoked" | "refresh_token_reused" | "device_mismatch";

type RefreshOutcome =
  | Readonly<{ ok: true; session: IssuedSession; device: DeviceRow; now: number }>
  | Readonly<{ ok: false; fail: RefreshFailure; removed?: RemovedDevices }>;

export type RefreshService = Readonly<{
  refresh(input: RefreshRequest): Promise<RefreshResponse>;
  logout(input: LogoutRequest): Promise<void>;
}>;

function failed(fail: RefreshFailure, removed?: RemovedDevices): RefreshOutcome {
  return removed === undefined ? { ok: false, fail } : { ok: false, fail, removed };
}

/** Whether the presented token is the one this row stores (claims and hash). */
function presentsRow(payload: RefreshTokenPayload, presentedHash: string, row: RefreshTokenRow): boolean {
  return refreshTokenMatchesRow(payload, row) && constantTimeEqual(presentedHash, row.token_hash);
}

/** A successor the client never used: current, unexpired, and no access token with its `rid` was seen. */
function isUnusedCurrent(row: RefreshTokenRow, now: number): boolean {
  return row.rotated_to_id === null && row.revoked_at === null && row.confirmed_at === null && row.expires_at > now;
}

export function createRefreshService(ctx: AppContext): RefreshService {
  const { env, db, clock } = ctx;
  const config = sessionConfig(env, ctx.keys);
  const graceMs = env.REFRESH_GRACE_SECONDS * SECOND_MS;

  /** The session goes out: the device reports its metadata and is seen now. */
  async function succeed(
    q: Queryable,
    user: UserRow,
    device: DeviceRow,
    patch: DevicePatch,
    session: IssuedSession,
    now: number,
  ): Promise<RefreshOutcome> {
    await updateDeviceReport(
      q,
      device.id,
      { reportedName: patch.name, osVersion: patch.osVersion, model: patch.model, clientVersion: patch.clientVersion },
      now,
    );
    const reported = await findDevice(q, user.id, device.id);
    if (reported === undefined) return failed("session_revoked");
    return { ok: true, session, device: reported, now };
  }

  /** DESIGN §3.15 item 5: a token rotated after the backup the database was restored from. */
  async function restoreGrace(
    q: Queryable,
    payload: RefreshTokenPayload,
    deviceHash: string,
    patch: DevicePatch,
    now: number,
  ): Promise<RefreshOutcome> {
    const graceUntil = await readRestoreGraceUntil(q);
    if (graceUntil === null || now >= graceUntil) return failed("session_revoked");
    const user = await findUser(q, payload.sub);
    const device = user === undefined ? undefined : await findDevice(q, payload.sub, payload.did);
    if (user === undefined || device === undefined) return failed("session_revoked");
    if (device.hwid_hash !== deviceHash) return failed("device_mismatch");
    const session = await issueSession(
      q,
      { userId: user.id, deviceId: device.id, authVersion: user.auth_version, now, replaceDeviceTokens: true },
      config,
    );
    return succeed(q, user, device, patch, session, now);
  }

  async function refresh(input: RefreshRequest): Promise<RefreshResponse> {
    const payload = parseRefreshToken(input.refreshToken, ctx.keys.refreshToken);
    if (payload === null || isRefreshTokenExpired(payload, clock.now())) {
      throw new AppError("invalid_refresh_token");
    }
    const presentedHash = hashToken(input.refreshToken);
    const deviceHash = hwidHash(input.device.hwid);

    const outcome = await db.write(async (q): Promise<RefreshOutcome> => {
      const now = clock.now();
      const row = await findRefreshToken(q, payload.tid);
      if (row === undefined) return restoreGrace(q, payload, deviceHash, input.device, now);
      if (!presentsRow(payload, presentedHash, row)) return failed("invalid_refresh_token");
      const user = await findUser(q, row.user_id);
      const device = user === undefined ? undefined : await findDevice(q, row.user_id, row.device_id);
      if (user === undefined || device === undefined) return failed("session_revoked");
      if (device.hwid_hash !== deviceHash) return failed("device_mismatch");

      if (row.rotated_to_id === null && row.revoked_at === null && row.expires_at > now) {
        const successorId = newId();
        if (await markRotated(q, row.id, successorId, now + graceMs)) {
          const session = await issueSession(
            q,
            { userId: user.id, deviceId: device.id, authVersion: user.auth_version, now, refreshId: successorId },
            config,
          );
          return succeed(q, user, device, input.device, session, now);
        }
      }

      // Lost the CAS or not current: read the row again (READ COMMITTED sees the winner's commit).
      const current = await findRefreshToken(q, row.id);
      const rotatedTo = current?.rotated_to_id ?? null;
      if (rotatedTo !== null && (current?.rotation_grace_expires_at ?? 0) > now) {
        const successor = await findRefreshToken(q, rotatedTo);
        if (successor !== undefined && isUnusedCurrent(successor, now)) {
          const session = tokensForRefreshRow(successor, user.auth_version, config, now);
          return succeed(q, user, device, input.device, session, now);
        }
        return failed("refresh_token_reused", await removeDevicesInTx(q, user.id, [device.id], "token_reuse"));
      }
      return failed("invalid_refresh_token");
    });

    if (!outcome.ok) {
      if (outcome.removed !== undefined) ctx.devices.afterRemove(outcome.removed);
      throw new AppError(outcome.fail);
    }
    return {
      tokens: { ...outcome.session.tokens },
      device: toDeviceDto(outcome.device, {
        currentDeviceId: outcome.device.id,
        now: outcome.now,
        newDeviceRestrictHours: env.NEW_DEVICE_RESTRICT_HOURS,
      }),
      serverId: ctx.serverId,
      serverTime: formatIso(outcome.now),
    };
  }

  async function logout(input: LogoutRequest): Promise<void> {
    const payload = parseRefreshToken(input.refreshToken, ctx.keys.refreshToken);
    if (payload === null) return;
    const presentedHash = hashToken(input.refreshToken);
    const removed = await db.write(async (q) => {
      const now = clock.now();
      const row = await findRefreshToken(q, payload.tid);
      if (row === undefined || !presentsRow(payload, presentedHash, row)) return null;
      const isCurrent = row.rotated_to_id === null && row.revoked_at === null;
      const inGrace = row.rotated_to_id !== null && (row.rotation_grace_expires_at ?? 0) > now;
      if (!isCurrent && !inGrace) return null;
      return removeDevicesInTx(q, row.user_id, [row.device_id], "device_signed_out");
    });
    if (removed !== null && removed.deviceIds.length > 0) ctx.devices.afterRemove(removed);
  }

  return Object.freeze({ refresh, logout });
}
