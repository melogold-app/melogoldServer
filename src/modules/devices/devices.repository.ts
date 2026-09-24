/**
 * Queries of the `devices` module (T1.2): the `devices` rows of a user, the reauth rows of `auth_throttle`
 * (`scope = 'reauth'`, DESIGN §4.1) and the inactive-device search (DESIGN §4.6, §4.12). Every function takes the
 * `q` of the caller's `db.read`/`db.write`/`db.run` and opens no transaction.
 *
 * Removing devices is not here: it goes only through `removeDevicesInTx` (`src/lib/device-removal.ts`).
 */
import type { Selectable } from "kysely";
import { selectInChunks } from "../../db/batch.ts";
import type { Queryable } from "../../db/index.ts";
import type { DevicesTable } from "../../db/types.ts";
import type { DeviceRecord } from "./device-dto.ts";

// ---------------------------------------------------------------------------------------------------------------------
// devices
// ---------------------------------------------------------------------------------------------------------------------

const DEVICE_COLUMNS = [
  "id",
  "reported_name",
  "custom_name",
  "platform",
  "os_version",
  "model",
  "client_version",
  "linked_via",
  "linked_by_device_id",
  "created_at",
  "last_seen_at",
  "last_sync_at",
] as const;

type DeviceRow = Pick<Selectable<DevicesTable>, (typeof DEVICE_COLUMNS)[number]>;

function toRecord(row: DeviceRow): DeviceRecord {
  return Object.freeze({
    id: row.id,
    reportedName: row.reported_name,
    customName: row.custom_name,
    platform: row.platform,
    osVersion: row.os_version,
    model: row.model,
    clientVersion: row.client_version,
    linkedVia: row.linked_via,
    linkedByDeviceId: row.linked_by_device_id,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    lastSyncAt: row.last_sync_at,
  });
}

/** Every device of the user, by `last_seen_at` descending, then `id` (API §4.4 puts the current one first in TS). */
export async function listUserDevices(q: Queryable, userId: string): Promise<DeviceRecord[]> {
  const rows = await q
    .selectFrom("devices")
    .select(DEVICE_COLUMNS)
    .where("user_id", "=", userId)
    .orderBy("last_seen_at", "desc")
    .orderBy("id")
    .execute();
  return rows.map(toRecord);
}

/** One device of the user; `undefined` for an unknown id or a device of another user. */
export async function findUserDevice(
  q: Queryable,
  userId: string,
  deviceId: string,
): Promise<DeviceRecord | undefined> {
  const row = await q
    .selectFrom("devices")
    .select(DEVICE_COLUMNS)
    .where("user_id", "=", userId)
    .where("id", "=", deviceId)
    .executeTakeFirst();
  return row && toRecord(row);
}

/** The user's devices among `deviceIds` (at most two in practice: the caller and the target). */
export async function findUserDevices(
  q: Queryable,
  userId: string,
  deviceIds: readonly string[],
): Promise<DeviceRecord[]> {
  const rows = await selectInChunks(deviceIds, (chunk) =>
    q.selectFrom("devices").select(DEVICE_COLUMNS).where("user_id", "=", userId).where("id", "in", chunk).execute(),
  );
  return rows.map(toRecord);
}

/** `custom_name = customName` (`null` returns to the reported name); the updated row, or `undefined` if it is gone. */
export async function setCustomName(
  q: Queryable,
  userId: string,
  deviceId: string,
  customName: string | null,
): Promise<DeviceRecord | undefined> {
  const row = await q
    .updateTable("devices")
    .set({ custom_name: customName })
    .where("user_id", "=", userId)
    .where("id", "=", deviceId)
    .returning(DEVICE_COLUMNS)
    .executeTakeFirst();
  return row && toRecord(row);
}

// ---------------------------------------------------------------------------------------------------------------------
// Inactive devices (DESIGN §4.6: no use for DEVICE_INACTIVE_DAYS and no live refresh token)
// ---------------------------------------------------------------------------------------------------------------------

export type InactiveCriteria = Readonly<{
  /** `last_seen_at` strictly before this time (`now − DEVICE_INACTIVE_DAYS`). */
  lastSeenBefore: number;
  /** A refresh token is live when `expires_at > now`, it is not revoked and not rotated. */
  now: number;
}>;

export type DeviceOfUser = Readonly<{ id: string; userId: string }>;

/** The oldest inactive devices of every user, at most `limit`, by `last_seen_at` then `id`. */
export async function findInactiveDevices(
  q: Queryable,
  criteria: InactiveCriteria,
  limit: number,
): Promise<DeviceOfUser[]> {
  const rows = await q
    .selectFrom("devices as d")
    .select(["d.id as id", "d.user_id as userId"])
    .where("d.last_seen_at", "<", criteria.lastSeenBefore)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("refresh_tokens as rt")
            .select("rt.id")
            .whereRef("rt.device_id", "=", "d.id")
            .where("rt.expires_at", ">", criteria.now)
            .where("rt.revoked_at", "is", null)
            .where("rt.rotated_to_id", "is", null),
        ),
      ),
    )
    .orderBy("d.last_seen_at")
    .orderBy("d.id")
    .limit(limit)
    .execute();
  return rows.map((row) => Object.freeze({ id: row.id, userId: row.userId }));
}

/** Which of `deviceIds` of the user are still inactive (the re-check under `lockUser`). */
export async function stillInactiveDevices(
  q: Queryable,
  userId: string,
  deviceIds: readonly string[],
  criteria: InactiveCriteria,
): Promise<string[]> {
  const rows = await selectInChunks(deviceIds, (chunk) =>
    q
      .selectFrom("devices as d")
      .select("d.id as id")
      .where("d.user_id", "=", userId)
      .where("d.id", "in", chunk)
      .where("d.last_seen_at", "<", criteria.lastSeenBefore)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("refresh_tokens as rt")
              .select("rt.id")
              .whereRef("rt.device_id", "=", "d.id")
              .where("rt.expires_at", ">", criteria.now)
              .where("rt.revoked_at", "is", null)
              .where("rt.rotated_to_id", "is", null),
          ),
        ),
      )
      .orderBy("d.id")
      .execute(),
  );
  return rows.map((row) => row.id);
}

// ---------------------------------------------------------------------------------------------------------------------
// Reauth (DESIGN §4.1: auth_throttle(scope = 'reauth', key = userId), 5 failures → 15 min)
// ---------------------------------------------------------------------------------------------------------------------

export const REAUTH_SCOPE = "reauth";

/** The stored password hash of a user that is not deleted. */
export async function findPasswordHash(q: Queryable, userId: string): Promise<string | undefined> {
  const row = await q
    .selectFrom("users")
    .select("password_hash")
    .where("id", "=", userId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  return row?.password_hash;
}

export type ThrottleState = Readonly<{ failures: number; windowStart: number; lockedUntil: number | null }>;

export async function readReauthThrottle(q: Queryable, keyHash: string): Promise<ThrottleState | undefined> {
  const row = await q
    .selectFrom("auth_throttle")
    .select(["failures", "window_start", "locked_until"])
    .where("scope", "=", REAUTH_SCOPE)
    .where("key_hash", "=", keyHash)
    .executeTakeFirst();
  return row && Object.freeze({ failures: row.failures, windowStart: row.window_start, lockedUntil: row.locked_until });
}

export type ReauthFailureRule = Readonly<{
  now: number;
  /** Failures older than this window (from the first failure of the window) are forgotten. */
  windowMs: number;
  /** The failure that brings the count to this value locks the key. */
  maxFailures: number;
  lockMs: number;
}>;

/**
 * Counts one failure in one statement (`INSERT … ON CONFLICT DO UPDATE … RETURNING`), so parallel failures never
 * lose a count on either dialect (docs/database.md §2.6). A window that ended, or a lock that expired, starts a new
 * window with this failure; the failure that reaches `maxFailures` sets `locked_until = now + lockMs`.
 */
export async function recordReauthFailure(
  q: Queryable,
  keyHash: string,
  rule: ReauthFailureRule,
): Promise<ThrottleState> {
  const { now } = rule;
  const lockedUntil = now + rule.lockMs;
  const row = await q
    .insertInto("auth_throttle")
    .values({
      scope: REAUTH_SCOPE,
      key_hash: keyHash,
      failures: 1,
      window_start: now,
      locked_until: rule.maxFailures <= 1 ? lockedUntil : null,
      updated_at: now,
    })
    .onConflict((conflict) =>
      conflict.columns(["scope", "key_hash"]).doUpdateSet((eb) => {
        const expired = eb.or([
          eb("auth_throttle.window_start", "<=", now - rule.windowMs),
          eb.and([eb("auth_throttle.locked_until", "is not", null), eb("auth_throttle.locked_until", "<=", now)]),
        ]);
        return {
          failures: eb
            .case()
            .when(expired)
            .then(eb.ref("excluded.failures"))
            .else(eb("auth_throttle.failures", "+", 1))
            .end(),
          window_start: eb
            .case()
            .when(expired)
            .then(eb.ref("excluded.window_start"))
            .else(eb.ref("auth_throttle.window_start"))
            .end(),
          locked_until: eb
            .case()
            .when(expired)
            .then(eb.ref("excluded.locked_until"))
            .when("auth_throttle.failures", ">=", rule.maxFailures - 1)
            .then(lockedUntil)
            .else(eb.ref("auth_throttle.locked_until"))
            .end(),
          updated_at: eb.ref("excluded.updated_at"),
        };
      }),
    )
    .returning(["failures", "window_start", "locked_until"])
    .executeTakeFirstOrThrow();
  return Object.freeze({ failures: row.failures, windowStart: row.window_start, lockedUntil: row.locked_until });
}

/** A successful reauth forgets the failures (DESIGN §4.1). */
export async function clearReauthThrottle(q: Queryable, keyHash: string): Promise<void> {
  await q.deleteFrom("auth_throttle").where("scope", "=", REAUTH_SCOPE).where("key_hash", "=", keyHash).execute();
}
