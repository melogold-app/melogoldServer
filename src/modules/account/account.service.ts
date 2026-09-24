/**
 * Account operations (API §4.5; DESIGN §4.8, §4.9, §4.11): password change, recovery code rotation and confirmation,
 * recovery by code, account deletion. The export lives in `export.ts`, the background purge in `purge.job.ts`.
 *
 * Shape of every write (docs/database.md): checks that need no lock and argon2 run **before** the transaction; the
 * transaction starts with `lockUser` where API §9.5 requires it (password change, recover, deletion); devices are
 * removed only through `removeDevicesInTx` / `removeAllDevicesInTx`; live events go out **after** the commit.
 *
 * Reauth (DESIGN §4.1, §4.8): actions that need the password consult `auth_throttle(scope='reauth', key=userId)`
 * first: a locked key answers `429 reauth_throttled{retryAfterSeconds}` without argon2; a wrong password answers
 * `403 invalid_password` and counts a failure (the 5th locks the key for 15 minutes); a right one removes the row.
 */
import type { AppContext } from "../../context.ts";
import type {
  ChangePasswordRequest,
  ChangePasswordResponse,
  ConfirmRecoveryCodeRequest,
  DeleteAccountRequest,
  RecoverRequest,
  RecoveryCodeResponse,
  RotateRecoveryCodeRequest,
} from "../../contract/account.ts";
import type { AuthSession } from "../../contract/common.ts";
import { lockUser } from "../../db/heads.ts";
import { MissingHeadError } from "../../db/tx.ts";
import type { RequestAuth } from "../../http/auth-guard.ts";
import { AppError } from "../../http/errors.ts";
import { MINUTE_MS } from "../../lib/clock.ts";
import { sha256Hex } from "../../lib/crypto.ts";
import { removeAllDevicesInTx } from "../../lib/device-removal.ts";
import type { RemovedDevices } from "../../lib/device-removal.ts";
import { newId } from "../../lib/ids.ts";
import { issueSession, sessionConfig } from "../../lib/session.ts";
import { formatIso } from "../../lib/time.ts";
import {
  RECOVERY_POLICY,
  changePasswordDecision,
  deleteAccountGate,
  rotateRecoveryCodeGate,
} from "../security/policy.ts";
import type { Gate } from "../security/policy.ts";
import * as repo from "./account.repository.ts";
import type { AccountUserRow, DeviceRow } from "./account.repository.ts";
import { assertNewPassword, normalizeLogin } from "./credentials.ts";
import type { PasswordHasher } from "./credentials.ts";
import { deviceName, toDeviceDto, toUserDto } from "./dto.ts";
import { generateRecoveryCode, recoveryCodeHash, recoveryCodeMatches } from "./recovery-code.ts";

/** `auth_throttle.scope` of the password re-check (API §9.2). */
export const REAUTH_SCOPE = "reauth";
/** API §5: "5 неудач → 15 мин". The 5th wrong password locks; the 6th attempt is refused without argon2. */
export const REAUTH_MAX_FAILURES = 5;
export const REAUTH_LOCK_MS = 15 * MINUTE_MS;
/** Failures older than this start a new count (the same 15-minute window as the login throttle). */
export const REAUTH_WINDOW_MS = 15 * MINUTE_MS;

/** `auth_throttle.key_hash` = `sha256(scope + ":" + key)` (API §9.2), key = user id. */
export function reauthKeyHash(userId: string): string {
  return sha256Hex(`${REAUTH_SCOPE}:${userId}`);
}

export type AccountServiceDeps = Readonly<{
  ctx: AppContext;
  passwords: PasswordHasher;
  /** Random bytes of new recovery codes (tests pass a fixed source). */
  randomBytes?: (size: number) => Uint8Array;
}>;

export type AccountService = Readonly<{
  changePassword(auth: RequestAuth, body: ChangePasswordRequest): Promise<ChangePasswordResponse>;
  rotateRecoveryCode(auth: RequestAuth, body: RotateRecoveryCodeRequest): Promise<RecoveryCodeResponse>;
  confirmRecoveryCode(auth: RequestAuth, body: ConfirmRecoveryCodeRequest): Promise<void>;
  deleteAccount(auth: RequestAuth, body: DeleteAccountRequest): Promise<void>;
  recover(body: RecoverRequest): Promise<AuthSession>;
}>;

function emptyToNull(value: string | undefined): string | null {
  return value === undefined || value === "" ? null : value;
}

export function createAccountService(deps: AccountServiceDeps): AccountService {
  const { ctx, passwords } = deps;
  const session = sessionConfig(ctx.env, ctx.keys);
  const newCode = () => generateRecoveryCode(deps.randomBytes);

  /** The caller's account; the guard checked it, but it may have been deleted since. */
  async function activeUser(userId: string): Promise<AccountUserRow> {
    const user = await ctx.db.run((q) => repo.findActiveUser(q, userId));
    if (!user) throw new AppError("session_revoked");
    return user;
  }

  async function verifyReauth(user: AccountUserRow, password: string): Promise<void> {
    const keyHash = reauthKeyHash(user.id);
    const lock = await ctx.db.run((q) => repo.findThrottleLock(q, REAUTH_SCOPE, keyHash));
    const now = ctx.clock.now();
    const lockedUntil = lock?.locked_until ?? null;
    if (lockedUntil !== null && lockedUntil > now) {
      const retryAfterSeconds = Math.max(1, Math.ceil((lockedUntil - now) / 1000));
      throw new AppError("reauth_throttled", { details: { retryAfterSeconds } });
    }
    if (await passwords.verify(user.password_hash, password)) {
      await ctx.db.run((q) => repo.clearThrottle(q, REAUTH_SCOPE, keyHash));
      return;
    }
    await ctx.db.run((q) =>
      repo.recordThrottleFailure(q, {
        scope: REAUTH_SCOPE,
        keyHash,
        now: ctx.clock.now(),
        windowMs: REAUTH_WINDOW_MS,
        maxFailures: REAUTH_MAX_FAILURES,
        lockMs: REAUTH_LOCK_MS,
      }),
    );
    throw new AppError("invalid_password");
  }

  /** Applies a gate of `security/policy.ts`. */
  async function passGate(gate: Gate, user: AccountUserRow): Promise<void> {
    switch (gate.outcome) {
      case "allow":
        return;
      case "refuse":
        throw new AppError(gate.code);
      case "verify_password":
        await verifyReauth(user, gate.password);
        return;
    }
  }

  function notifyOthers(
    auth: RequestAuth,
    device: DeviceRow,
    reason: "password_changed" | "password_changed_without_old" | "recovery_code_rotated",
  ): void {
    ctx.live.publish(
      auth.userId,
      "account.updated",
      { reason, byDevice: { id: device.id, name: deviceName(device) } },
      { exceptDeviceId: auth.deviceId },
    );
  }

  return Object.freeze({
    async changePassword(auth: RequestAuth, body: ChangePasswordRequest): Promise<ChangePasswordResponse> {
      const decision = changePasswordDecision(body.currentPassword);
      const user = await activeUser(auth.userId);
      assertNewPassword(body.newPassword, user.login);
      await passGate(decision.gate, user);
      const passwordHash = await passwords.hash(body.newPassword);

      const out = await ctx.db.write(async (q) => {
        await lockUser(q, auth.userId);
        const now = ctx.clock.now();
        const me = await repo.findDevice(q, auth.userId, auth.deviceId);
        if (!me) throw new AppError("session_revoked");
        const updated = await repo.updatePassword(q, {
          userId: auth.userId,
          expectedAuthVersion: auth.authVersion,
          passwordHash,
          now,
        });
        if (!updated) throw new AppError("access_token_expired");
        const removed: RemovedDevices | null =
          body.signOutOtherDevices === true
            ? await removeAllDevicesInTx(q, auth.userId, "password_changed", { exceptDeviceId: auth.deviceId })
            : null;
        const issued = await issueSession(
          q,
          {
            userId: auth.userId,
            deviceId: auth.deviceId,
            authVersion: updated.auth_version,
            now,
            replaceDeviceTokens: true,
          },
          session,
        );
        return { me, updated, removed, issued };
      });

      if (out.removed) ctx.devices.afterRemove(out.removed);
      notifyOthers(auth, out.me, decision.notifyReason);
      // auth_version moved on: every stream of the user, the author's too, was opened with an outdated token.
      ctx.live.closeUser(auth.userId);
      return {
        user: toUserDto(out.updated),
        tokens: out.issued.tokens,
        signedOutDevices: out.removed?.deviceIds.length ?? 0,
      };
    },

    async rotateRecoveryCode(auth: RequestAuth, body: RotateRecoveryCodeRequest): Promise<RecoveryCodeResponse> {
      const user = await activeUser(auth.userId);
      await passGate(rotateRecoveryCodeGate(body.password), user);
      const code = newCode();

      const out = await ctx.db.write(async (q) => {
        const now = ctx.clock.now();
        const me = await repo.findDevice(q, auth.userId, auth.deviceId);
        if (!me) throw new AppError("session_revoked");
        const updated = await repo.replaceRecoveryCode(q, { userId: auth.userId, recoveryCodeHash: code.hash, now });
        if (!updated) throw new AppError("session_revoked");
        return { me, updated };
      });

      notifyOthers(auth, out.me, "recovery_code_rotated");
      return { recoveryCode: code.display, createdAt: formatIso(out.updated.recovery_code_created_at) };
    },

    async confirmRecoveryCode(auth: RequestAuth, body: ConfirmRecoveryCodeRequest): Promise<void> {
      const result = await ctx.db.write((q) =>
        repo.confirmRecoveryCode(q, {
          userId: auth.userId,
          createdAt: body.recoveryCodeCreatedAt,
          now: ctx.clock.now(),
        }),
      );
      if (result === "outdated") throw new AppError("recovery_code_outdated");
    },

    async deleteAccount(auth: RequestAuth, body: DeleteAccountRequest): Promise<void> {
      const user = await activeUser(auth.userId);
      await passGate(deleteAccountGate(body.password), user);

      const removed = await ctx.db.write(async (q) => {
        await lockUser(q, auth.userId);
        const now = ctx.clock.now();
        if (!(await repo.markUserDeleted(q, auth.userId, now))) throw new AppError("session_revoked");
        const devices = await removeAllDevicesInTx(q, auth.userId, "account_deleted");
        await repo.deleteLinksAndPlayback(q, auth.userId);
        return devices;
      });

      // session.invalidated{account_deleted} to every removed device, closeDevice, then closeUser.
      ctx.devices.afterRemove(removed);
    },

    async recover(body: RecoverRequest): Promise<AuthSession> {
      const login = normalizeLogin(body.login);
      assertNewPassword(body.newPassword, login);
      const target = await ctx.db.run((q) => repo.findRecoveryTarget(q, login));
      if (!recoveryCodeMatches(target?.recovery_code_hash ?? null, body.recoveryCode) || target === undefined) {
        throw new AppError("invalid_recovery_code");
      }
      const passwordHash = await passwords.hash(body.newPassword);
      const code = newCode();
      const userId = target.id;

      const out = await ctx.db
        .write(async (q) => {
          await lockUser(q, userId);
          const now = ctx.clock.now();
          const updated = await repo.resetCredentials(q, {
            userId,
            expectedCodeHash: recoveryCodeHash(body.recoveryCode),
            passwordHash,
            recoveryCodeHash: code.hash,
            now,
          });
          if (!updated) throw new AppError("invalid_recovery_code");
          const removed = await removeAllDevicesInTx(q, userId, "recovery_reset");
          const device: DeviceRow = {
            id: newId(),
            user_id: userId,
            hwid_hash: sha256Hex(body.device.hwid),
            reported_name: body.device.name,
            custom_name: null,
            platform: body.device.platform,
            os_version: emptyToNull(body.device.osVersion),
            model: emptyToNull(body.device.model),
            client_version: emptyToNull(body.device.clientVersion),
            linked_via: RECOVERY_POLICY.newDeviceLinkedVia,
            linked_by_device_id: null,
            created_at: now,
            last_seen_at: now,
            last_sync_at: null,
          };
          await repo.insertDevice(q, device);
          const issued = await issueSession(
            q,
            { userId, deviceId: device.id, authVersion: updated.auth_version, now },
            session,
          );
          return { now, updated, removed, device, issued };
        })
        .catch((error: unknown) => {
          // The account was deleted and purged between the lookup and the lock.
          if (error instanceof MissingHeadError) throw new AppError("invalid_recovery_code");
          throw error;
        });

      // session.invalidated{recovery_reset} to every previous device, then their streams close.
      ctx.devices.afterRemove(out.removed);
      return {
        user: toUserDto(out.updated),
        device: toDeviceDto(out.device, {
          currentDeviceId: out.device.id,
          now: out.now,
          newDeviceRestrictHours: ctx.env.NEW_DEVICE_RESTRICT_HOURS,
        }),
        tokens: out.issued.tokens,
        serverId: ctx.serverId,
        serverTime: formatIso(out.now),
        recoveryCode: code.display,
        signedOutDevices: out.removed.deviceIds.length,
      };
    },
  });
}
