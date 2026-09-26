/**
 * The administrator's account commands (`melogold user …`, DESIGN §7.4, PLAN T3.1), run by the CLI in a process of
 * its own. They change the database only; the server notices at the next heartbeat of its live streams
 * (`src/modules/live/revalidate.ts`): a removed device gets `session.invalidated{device_revoked}` and its streams
 * close, a raised `auth_version` closes the streams, a deleted account gets `account_deleted`.
 *
 * - {@link resetPasswordByAdmin}: new password and recovery code, `auth_version + 1`, every device signed out
 *   (`removeAllDevicesInTx`, like a recovery);
 * - {@link deleteAccountByAdmin}: the logical deletion of `POST /auth/me/delete` (DESIGN §4.11), without the password;
 *   `account-purge` removes the rows later;
 * - {@link listAccounts}, {@link listAccountDevices}: read-only;
 * - {@link revokeDeviceByAdmin}: one device, like `POST /auth/me/devices/{id}/revoke`.
 */
import type { Env } from "../../config/env.ts";
import type { Db } from "../../db/index.ts";
import { lockUser } from "../../db/heads.ts";
import { AppError } from "../../http/errors.ts";
import type { Clock } from "../../lib/clock.ts";
import { removeAllDevicesInTx, removeDevicesInTx } from "../../lib/device-removal.ts";
import {
  adminResetCredentials,
  countUsage,
  deleteLinksAndPlayback,
  findActiveUserByLogin,
  listActiveUsers,
  listDevices,
  markUserDeleted,
} from "./account.repository.ts";
import type { AccountUsage, AdminAccountRow, DeviceRow } from "./account.repository.ts";
import { assertNewPassword, createPasswordHasher, normalizeLogin } from "./credentials.ts";
import { generateRecoveryCode } from "./recovery-code.ts";

export type { AccountUsage } from "./account.repository.ts";

export type AccountAdminDeps = Readonly<{
  db: Pick<Db, "read" | "run" | "write">;
  clock: Pick<Clock, "now">;
  env: Env;
}>;

/** The active account of `login`. @throws AppError `not_found` when there is none. */
export async function findAccount(deps: Pick<AccountAdminDeps, "db">, login: string): Promise<AdminAccountRow> {
  const account = await deps.db.run((q) => findActiveUserByLogin(q, normalizeLogin(login)));
  if (account === undefined) throw new AppError("not_found", { message: `no active account "${login}"` });
  return account;
}

export type PasswordReset = Readonly<{ login: string; recoveryCode: string; signedOutDevices: number }>;

/**
 * `melogold user reset-password`: a new password and recovery code; every device of the account is signed out.
 * @throws AppError `not_found` (no such account) or a `password_*` refusal.
 */
export async function resetPasswordByAdmin(
  deps: AccountAdminDeps,
  input: Readonly<{ login: string; password: string }>,
): Promise<PasswordReset> {
  const account = await findAccount(deps, input.login);
  assertNewPassword(input.password, account.login);
  const passwordHash = await createPasswordHasher(deps.env).hash(input.password);
  const code = generateRecoveryCode();
  const removed = await deps.db.write(async (q) => {
    await lockUser(q, account.id);
    const updated = await adminResetCredentials(q, {
      userId: account.id,
      passwordHash,
      recoveryCodeHash: code.hash,
      now: deps.clock.now(),
    });
    if (!updated) throw new AppError("not_found", { message: `no active account "${input.login}"` });
    return removeAllDevicesInTx(q, account.id, "recovery_reset");
  });
  return Object.freeze({
    login: account.login,
    recoveryCode: code.display,
    signedOutDevices: removed.deviceIds.length,
  });
}

/**
 * `melogold user delete`: marks the account deleted, signs out its devices, drops its links and playback state.
 * @returns how many devices were signed out.
 * @throws AppError `not_found` when there is no such active account.
 */
export async function deleteAccountByAdmin(deps: AccountAdminDeps, login: string): Promise<number> {
  const account = await findAccount(deps, login);
  const removed = await deps.db.write(async (q) => {
    await lockUser(q, account.id);
    if (!(await markUserDeleted(q, account.id, deps.clock.now()))) {
      throw new AppError("not_found", { message: `no active account "${login}"` });
    }
    const devices = await removeAllDevicesInTx(q, account.id, "account_deleted");
    await deleteLinksAndPlayback(q, account.id);
    return devices;
  });
  return removed.deviceIds.length;
}

export type AccountListEntry = Readonly<{
  login: string;
  createdAt: number;
  createdBy: string;
  devices: number;
  lastSeenAt: number | null;
  usage?: AccountUsage;
}>;

/** `melogold user list [--usage]`: the active accounts by login. */
export async function listAccounts(
  deps: Pick<AccountAdminDeps, "db">,
  options: Readonly<{ usage: boolean }>,
): Promise<AccountListEntry[]> {
  const rows = await deps.db.read((q) => listActiveUsers(q));
  const entries: AccountListEntry[] = [];
  for (const row of rows) {
    const entry = {
      login: row.login,
      createdAt: row.created_at,
      createdBy: row.created_by,
      devices: row.devices,
      lastSeenAt: row.last_seen_at,
    };
    entries.push(options.usage ? { ...entry, usage: await deps.db.read((q) => countUsage(q, row.id)) } : entry);
  }
  return entries;
}

/** `melogold user devices <login>`: the account's devices, oldest first. */
export async function listAccountDevices(deps: Pick<AccountAdminDeps, "db">, login: string): Promise<DeviceRow[]> {
  const account = await findAccount(deps, login);
  return deps.db.read((q) => listDevices(q, account.id));
}

/**
 * `melogold user revoke-device <login> <device-id>`.
 * @returns whether the device existed and was removed.
 */
export async function revokeDeviceByAdmin(deps: AccountAdminDeps, login: string, deviceId: string): Promise<boolean> {
  const account = await findAccount(deps, login);
  const removed = await deps.db.write(async (q) => {
    await lockUser(q, account.id);
    return removeDevicesInTx(q, account.id, [deviceId], "device_revoked");
  });
  return removed.deviceIds.length > 0;
}
