/**
 * Queries of the `auth` module (API §9.2 `0001_core`): accounts (`users`), the devices sessions belong to
 * (`devices`), refresh token rows (`refresh_tokens`), failed-attempt counters (`auth_throttle`), and the two
 * `server_meta` keys registration and refresh read: `first_user_id` (DESIGN §4.2) and `restore_refresh_grace_until`
 * (DESIGN §3.15 item 5).
 *
 * Every function takes `q` (a transaction or the `db.run` handle) and opens no transaction itself. Constraint
 * violations are never caught: inserts that may meet a concurrent writer use `ON CONFLICT … DO NOTHING RETURNING`,
 * updates that may race use CAS with a row count (docs/database.md §2.6, §3).
 */
import type { Insertable, Selectable } from "kysely";
import type { Queryable } from "../../db/index.ts";
import type { AuthThrottleTable, DevicesTable, RefreshTokensTable, UsersTable } from "../../db/types.ts";

export type UserRow = Selectable<UsersTable>;
export type DeviceRow = Selectable<DevicesTable>;
export type RefreshTokenRow = Selectable<RefreshTokensTable>;
export type ThrottleRow = Selectable<AuthThrottleTable>;

/** `server_meta` keys read here (the `server` module owns the table and names the same keys). */
export const META_FIRST_USER_ID = "first_user_id";
export const META_RESTORE_REFRESH_GRACE_UNTIL = "restore_refresh_grace_until";

// ---------------------------------------------------------------------------------------------------------------------
// server_meta
// ---------------------------------------------------------------------------------------------------------------------

async function readMeta(q: Queryable, key: string): Promise<string | null> {
  const row = await q.selectFrom("server_meta").select("value").where("key", "=", key).executeTakeFirst();
  return row?.value ?? null;
}

/** `server_meta.first_user_id`, or `null` while no user was ever created. */
export function readFirstUserId(q: Queryable): Promise<string | null> {
  return readMeta(q, META_FIRST_USER_ID);
}

/**
 * Claims the first-user slot (DESIGN §4.2): `INSERT … ON CONFLICT DO NOTHING RETURNING`.
 * @returns whether this user is the first one.
 */
export async function claimFirstUser(q: Queryable, userId: string): Promise<boolean> {
  const row = await q
    .insertInto("server_meta")
    .values({ key: META_FIRST_USER_ID, value: userId })
    .onConflict((conflict) => conflict.column("key").doNothing())
    .returning("key")
    .executeTakeFirst();
  return row !== undefined;
}

/** `server_meta.restore_refresh_grace_until` (epoch ms), or `null` when no restore opened the window. */
export async function readRestoreGraceUntil(q: Queryable): Promise<number | null> {
  const value = await readMeta(q, META_RESTORE_REFRESH_GRACE_UNTIL);
  if (value === null || !/^\d{1,16}$/.test(value)) return null;
  return Number(value);
}

// ---------------------------------------------------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------------------------------------------------

/** The live (not deleted) account with this normalized login. */
export function findUserByLogin(q: Queryable, login: string): Promise<UserRow | undefined> {
  return q
    .selectFrom("users")
    .selectAll()
    .where("login", "=", login)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
}

/** The live account with this id. */
export function findUser(q: Queryable, userId: string): Promise<UserRow | undefined> {
  return q.selectFrom("users").selectAll().where("id", "=", userId).where("deleted_at", "is", null).executeTakeFirst();
}

/** Whether any row holds this login (a deleted account holds `!deleted:<id>`, so its login is free). */
export async function loginExists(q: Queryable, login: string): Promise<boolean> {
  const row = await q.selectFrom("users").select("id").where("login", "=", login).executeTakeFirst();
  return row !== undefined;
}

/**
 * Inserts a user unless the login is taken meanwhile (`ON CONFLICT (login) DO NOTHING RETURNING`).
 * @returns whether the row was inserted.
 */
export async function insertUser(q: Queryable, user: Insertable<UsersTable>): Promise<boolean> {
  const row = await q
    .insertInto("users")
    .values(user)
    .onConflict((conflict) => conflict.column("login").doNothing())
    .returning("id")
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * Replaces the password hash after a rehash (DESIGN §4.1 `needsRehash`), only if the hash is still the one that was
 * verified (CAS): a concurrent password change wins.
 * @returns whether the hash was replaced.
 */
export async function replacePasswordHash(
  q: Queryable,
  userId: string,
  verifiedHash: string,
  newHash: string,
  now: number,
): Promise<boolean> {
  const result = await q
    .updateTable("users")
    .set({ password_hash: newHash, updated_at: now })
    .where("id", "=", userId)
    .where("password_hash", "=", verifiedHash)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

// ---------------------------------------------------------------------------------------------------------------------
// devices
// ---------------------------------------------------------------------------------------------------------------------

export function findDevice(q: Queryable, userId: string, deviceId: string): Promise<DeviceRow | undefined> {
  return q
    .selectFrom("devices")
    .selectAll()
    .where("id", "=", deviceId)
    .where("user_id", "=", userId)
    .executeTakeFirst();
}

/** The device of the user with this `sha256(hwid)` (`UNIQUE (user_id, hwid_hash)`). */
export function findDeviceByHwid(q: Queryable, userId: string, hwidHash: string): Promise<DeviceRow | undefined> {
  return q
    .selectFrom("devices")
    .selectAll()
    .where("user_id", "=", userId)
    .where("hwid_hash", "=", hwidHash)
    .executeTakeFirst();
}

export async function countDevices(q: Queryable, userId: string): Promise<number> {
  const row = await q
    .selectFrom("devices")
    .select((eb) => eb.fn.countAll<number | string>().as("count"))
    .where("user_id", "=", userId)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

/** Inserts a device row (under `lockUser`, after the caller checked that `(user, hwid)` is new). */
export async function insertDevice(q: Queryable, device: Insertable<DevicesTable>): Promise<void> {
  await q.insertInto("devices").values(device).execute();
}

/** Device metadata the client reports; `undefined` keeps the stored value. */
export type DeviceReport = Readonly<{
  reportedName?: string | undefined;
  platform?: string | undefined;
  osVersion?: string | undefined;
  model?: string | undefined;
  clientVersion?: string | undefined;
}>;

/** Writes what the client reports about the device and `last_seen_at = now` (login with a known hwid, refresh). */
export async function updateDeviceReport(
  q: Queryable,
  deviceId: string,
  report: DeviceReport,
  now: number,
): Promise<void> {
  await q
    .updateTable("devices")
    .set({
      last_seen_at: now,
      ...(report.reportedName === undefined ? {} : { reported_name: report.reportedName }),
      ...(report.platform === undefined ? {} : { platform: report.platform }),
      ...(report.osVersion === undefined ? {} : { os_version: report.osVersion }),
      ...(report.model === undefined ? {} : { model: report.model }),
      ...(report.clientVersion === undefined ? {} : { client_version: report.clientVersion }),
    })
    .where("id", "=", deviceId)
    .execute();
}

// ---------------------------------------------------------------------------------------------------------------------
// refresh_tokens
// ---------------------------------------------------------------------------------------------------------------------

export function findRefreshToken(q: Queryable, tokenId: string): Promise<RefreshTokenRow | undefined> {
  return q.selectFrom("refresh_tokens").selectAll().where("id", "=", tokenId).executeTakeFirst();
}

/**
 * CAS of the rotation (DESIGN §4.4): marks the current token as rotated to `successorId` with a grace window, only if
 * it is still current. The successor row is inserted afterwards by `issueSession` with `refreshId = successorId`.
 * @returns whether this caller won the rotation.
 */
export async function markRotated(
  q: Queryable,
  tokenId: string,
  successorId: string,
  graceExpiresAt: number,
): Promise<boolean> {
  const result = await q
    .updateTable("refresh_tokens")
    .set({ rotated_to_id: successorId, rotation_grace_expires_at: graceExpiresAt })
    .where("id", "=", tokenId)
    .where("rotated_to_id", "is", null)
    .where("revoked_at", "is", null)
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

// ---------------------------------------------------------------------------------------------------------------------
// auth_throttle
// ---------------------------------------------------------------------------------------------------------------------

export function findThrottle(q: Queryable, scope: string, keyHash: string): Promise<ThrottleRow | undefined> {
  return q
    .selectFrom("auth_throttle")
    .selectAll()
    .where("scope", "=", scope)
    .where("key_hash", "=", keyHash)
    .executeTakeFirst();
}

/** The counter after a failure was counted. */
export type ThrottleCount = Readonly<{ failures: number; windowStart: number; lockedUntil: number | null }>;

/**
 * Counts one failure atomically (one `INSERT … ON CONFLICT DO UPDATE … RETURNING`, which also locks the row for the
 * rest of the transaction in PostgreSQL). A window that is over (`window_start <= now - windowMs`) and not locked
 * starts again at 1.
 */
export async function countThrottleFailure(
  q: Queryable,
  scope: string,
  keyHash: string,
  now: number,
  windowMs: number,
): Promise<ThrottleCount> {
  const windowOver = now - windowMs;
  const row = await q
    .insertInto("auth_throttle")
    .values({ scope, key_hash: keyHash, failures: 1, window_start: now, locked_until: null, updated_at: now })
    .onConflict((conflict) =>
      conflict.columns(["scope", "key_hash"]).doUpdateSet((eb) => {
        const restart = eb.and([
          eb("auth_throttle.window_start", "<=", windowOver),
          eb.or([eb("auth_throttle.locked_until", "is", null), eb("auth_throttle.locked_until", "<=", now)]),
        ]);
        return {
          failures: eb
            .case()
            .when(restart)
            .then(eb.lit(1))
            .else(eb("auth_throttle.failures", "+", eb.lit(1)))
            .end(),
          window_start: eb.case().when(restart).then(now).else(eb.ref("auth_throttle.window_start")).end(),
          locked_until: eb.case().when(restart).then(eb.lit(null)).else(eb.ref("auth_throttle.locked_until")).end(),
          updated_at: now,
        };
      }),
    )
    .returning(["failures", "window_start", "locked_until"])
    .executeTakeFirstOrThrow();
  return { failures: row.failures, windowStart: row.window_start, lockedUntil: row.locked_until };
}

/**
 * Sets the lock of a counter the same transaction just counted ({@link countThrottleFailure}); the `failures`
 * condition is a CAS against any other writer.
 */
export async function lockThrottle(
  q: Queryable,
  scope: string,
  keyHash: string,
  failures: number,
  lockedUntil: number,
): Promise<void> {
  await q
    .updateTable("auth_throttle")
    .set({ locked_until: lockedUntil })
    .where("scope", "=", scope)
    .where("key_hash", "=", keyHash)
    .where("failures", "=", failures)
    .execute();
}

/** A success removes the counter (API §5). */
export async function deleteThrottle(q: Queryable, scope: string, keyHash: string): Promise<void> {
  await q.deleteFrom("auth_throttle").where("scope", "=", scope).where("key_hash", "=", keyHash).execute();
}
