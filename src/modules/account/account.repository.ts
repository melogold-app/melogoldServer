/**
 * Queries of the `account` module (PLAN T1.3). Every function takes the transaction `q` of the service's
 * `db.read` / `db.write` / `db.run` and opens none itself (docs/database.md §2.1).
 *
 * The account is the one place that reads or deletes **every** row of a user, so besides `users` this repository
 * reads the user's devices, the reauth rows of `auth_throttle`, the library and history for the export (keyset pages,
 * API §4.5), and deletes all of it for `account-purge` (batches of 5000, DESIGN §4.11).
 *
 * Portability (docs/database.md §4): times and ids come from TS; no `now()`; ordering only by `ID` columns and
 * numbers; keyset pages end on a unique key; background deletes are `DELETE … WHERE (pk…) IN (SELECT pk… LIMIT ?)`.
 */
import { sql } from "kysely";
import type { Selectable } from "kysely";
import type { Queryable } from "../../db/index.ts";
import type {
  Database,
  DevicesTable,
  PlaybackStateTable,
  PlayEventsTable,
  PlayForgetsTable,
  PlayStatsTable,
  SyncBookmarksTable,
  SyncLikesTable,
  SyncPlaylistItemsTable,
  SyncPlaylistsTable,
  SyncTracksTable,
} from "../../db/types.ts";

// ---------------------------------------------------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------------------------------------------------

/** The `users` columns the account module works with (no `recovery_code_hash`: see {@link findRecoveryTarget}). */
export type AccountUserRow = Readonly<{
  id: string;
  login: string;
  password_hash: string;
  auth_version: number;
  password_changed_at: number;
  recovery_code_created_at: number;
  recovery_code_confirmed_at: number | null;
  created_at: number;
}>;

const USER_COLUMNS = [
  "id",
  "login",
  "password_hash",
  "auth_version",
  "password_changed_at",
  "recovery_code_created_at",
  "recovery_code_confirmed_at",
  "created_at",
] as const;

/** A user that is not deleted. */
export async function findActiveUser(q: Queryable, userId: string): Promise<AccountUserRow | undefined> {
  return q
    .selectFrom("users")
    .select(USER_COLUMNS)
    .where("id", "=", userId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
}

/** `POST /auth/recover`: the account of a normalized login and its recovery code hash; deleted accounts never match. */
export async function findRecoveryTarget(
  q: Queryable,
  login: string,
): Promise<Readonly<{ id: string; recovery_code_hash: string }> | undefined> {
  return q
    .selectFrom("users")
    .select(["id", "recovery_code_hash"])
    .where("login", "=", login)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
}

/**
 * Password change: new hash, `auth_version + 1`, `password_changed_at = now`, as a CAS on the `auth_version` the
 * caller's access token carries (`av`).
 * @returns the updated user, or `undefined` when the user is deleted or `auth_version` moved on.
 */
export async function updatePassword(
  q: Queryable,
  input: Readonly<{ userId: string; expectedAuthVersion: number; passwordHash: string; now: number }>,
): Promise<AccountUserRow | undefined> {
  return q
    .updateTable("users")
    .set((eb) => ({
      password_hash: input.passwordHash,
      auth_version: eb("auth_version", "+", 1),
      password_changed_at: input.now,
      updated_at: input.now,
    }))
    .where("id", "=", input.userId)
    .where("deleted_at", "is", null)
    .where("auth_version", "=", input.expectedAuthVersion)
    .returning(USER_COLUMNS)
    .executeTakeFirst();
}

/**
 * Recovery (DESIGN §4.9): CAS on the old code hash. New password, `auth_version + 1`, a new unconfirmed code.
 * @returns the updated user, or `undefined` when the code changed meanwhile (a concurrent recover or rotation won) or
 * the account was deleted.
 */
export async function resetCredentials(
  q: Queryable,
  input: Readonly<{
    userId: string;
    expectedCodeHash: string;
    passwordHash: string;
    recoveryCodeHash: string;
    now: number;
  }>,
): Promise<AccountUserRow | undefined> {
  return q
    .updateTable("users")
    .set((eb) => ({
      password_hash: input.passwordHash,
      auth_version: eb("auth_version", "+", 1),
      password_changed_at: input.now,
      recovery_code_hash: input.recoveryCodeHash,
      recovery_code_created_at: input.now,
      recovery_code_confirmed_at: null,
      updated_at: input.now,
    }))
    .where("id", "=", input.userId)
    .where("recovery_code_hash", "=", input.expectedCodeHash)
    .where("deleted_at", "is", null)
    .returning(USER_COLUMNS)
    .executeTakeFirst();
}

/**
 * A new recovery code (`POST /auth/me/recovery-code`): replaces the hash, `created_at = now`, unconfirmed.
 * @returns the updated user, or `undefined` when the account is deleted.
 */
export async function replaceRecoveryCode(
  q: Queryable,
  input: Readonly<{ userId: string; recoveryCodeHash: string; now: number }>,
): Promise<AccountUserRow | undefined> {
  return q
    .updateTable("users")
    .set({
      recovery_code_hash: input.recoveryCodeHash,
      recovery_code_created_at: input.now,
      recovery_code_confirmed_at: null,
      updated_at: input.now,
    })
    .where("id", "=", input.userId)
    .where("deleted_at", "is", null)
    .returning(USER_COLUMNS)
    .executeTakeFirst();
}

/**
 * "I saved the code" for the code created at `createdAt`: sets `recovery_code_confirmed_at` once.
 * @returns `confirmed` (set now or already before) or `outdated` (the current code has another creation time).
 */
export async function confirmRecoveryCode(
  q: Queryable,
  input: Readonly<{ userId: string; createdAt: number; now: number }>,
): Promise<"confirmed" | "outdated"> {
  await q
    .updateTable("users")
    .set({ recovery_code_confirmed_at: input.now, updated_at: input.now })
    .where("id", "=", input.userId)
    .where("deleted_at", "is", null)
    .where("recovery_code_created_at", "=", input.createdAt)
    .where("recovery_code_confirmed_at", "is", null)
    .execute();
  const row = await q
    .selectFrom("users")
    .select("recovery_code_created_at")
    .where("id", "=", input.userId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  return row?.recovery_code_created_at === input.createdAt ? "confirmed" : "outdated";
}

/** The login a deleted account keeps, which frees its real login at once (API §9.2: `'!deleted:' || id`). */
export function deletedLogin(userId: string): string {
  return `!deleted:${userId}`;
}

/** The `password_hash` of a deleted account: not a PHC string, so no password ever verifies. */
export const DELETED_PASSWORD_HASH = "!";

/**
 * Logical deletion (DESIGN §4.11 steps 1–3): `deleted_at = now`, `login = '!deleted:' || id`, `password_hash = '!'`,
 * `auth_version + 1`.
 * @returns whether this call deleted the account (`false`: already deleted or unknown).
 */
export async function markUserDeleted(q: Queryable, userId: string, now: number): Promise<boolean> {
  const result = await q
    .updateTable("users")
    .set((eb) => ({
      deleted_at: now,
      login: deletedLogin(userId),
      password_hash: DELETED_PASSWORD_HASH,
      auth_version: eb("auth_version", "+", 1),
      updated_at: now,
    }))
    .where("id", "=", userId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

/** DESIGN §4.11 step 5: the user's device links (any status) and playback state go with the deletion. */
export async function deleteLinksAndPlayback(q: Queryable, userId: string): Promise<void> {
  await q.deleteFrom("device_links").where("user_id", "=", userId).execute();
  await q.deleteFrom("playback_state").where("user_id", "=", userId).execute();
}

// ---------------------------------------------------------------------------------------------------------------------
// devices
// ---------------------------------------------------------------------------------------------------------------------

export type DeviceRow = Selectable<DevicesTable>;

/** One device of the user. */
export async function findDevice(q: Queryable, userId: string, deviceId: string): Promise<DeviceRow | undefined> {
  return q
    .selectFrom("devices")
    .selectAll()
    .where("id", "=", deviceId)
    .where("user_id", "=", userId)
    .executeTakeFirst();
}

/** Every device of the user, oldest first (`created_at`, then `id`). */
export async function listDevices(q: Queryable, userId: string): Promise<DeviceRow[]> {
  return q
    .selectFrom("devices")
    .selectAll()
    .where("user_id", "=", userId)
    .orderBy("created_at")
    .orderBy("id")
    .execute();
}

/** Inserts a device row (the recovery device: every other device of the user was removed in the same transaction). */
export async function insertDevice(q: Queryable, row: DeviceRow): Promise<void> {
  await q.insertInto("devices").values(row).execute();
}

// ---------------------------------------------------------------------------------------------------------------------
// auth_throttle (scope `reauth`, key = user id; DESIGN §4.1, API §5)
// ---------------------------------------------------------------------------------------------------------------------

/** The lock of a throttle row: `locked_until` (epoch ms) or `null`. */
export async function findThrottleLock(
  q: Queryable,
  scope: string,
  keyHash: string,
): Promise<Readonly<{ failures: number; locked_until: number | null }> | undefined> {
  return q
    .selectFrom("auth_throttle")
    .select(["failures", "locked_until"])
    .where("scope", "=", scope)
    .where("key_hash", "=", keyHash)
    .executeTakeFirst();
}

export type ThrottleFailureInput = Readonly<{
  scope: string;
  keyHash: string;
  now: number;
  /** Failures older than this window start a new count. */
  windowMs: number;
  /** The failure that reaches this count locks the key. */
  maxFailures: number;
  lockMs: number;
}>;

/**
 * Records one failure in one statement (no read-modify-write): a new row, or `failures + 1` inside the window (a
 * window older than `windowMs` restarts at 1 and drops an old lock). The failure that reaches `maxFailures` sets
 * `locked_until`.
 * @returns the row after the failure.
 */
export async function recordThrottleFailure(
  q: Queryable,
  input: ThrottleFailureInput,
): Promise<Readonly<{ failures: number; locked_until: number | null }>> {
  const lockUntil = input.now + input.lockMs;
  const windowFloor = input.now - input.windowMs;
  const row = await q
    .insertInto("auth_throttle")
    .values({
      scope: input.scope,
      key_hash: input.keyHash,
      failures: 1,
      window_start: input.now,
      locked_until: input.maxFailures <= 1 ? lockUntil : null,
      updated_at: input.now,
    })
    .onConflict((conflict) =>
      conflict.columns(["scope", "key_hash"]).doUpdateSet((eb) => {
        const expired = eb("auth_throttle.window_start", "<=", windowFloor);
        return {
          failures: eb
            .case()
            .when(expired)
            .then(eb.cast<number>(eb.val(1), "integer"))
            .else(eb("auth_throttle.failures", "+", 1))
            .end(),
          window_start: eb
            .case()
            .when(expired)
            .then(eb.cast<number>(eb.val(input.now), "bigint"))
            .else(eb.ref("auth_throttle.window_start"))
            .end(),
          locked_until: eb
            .case()
            .when(expired)
            .then(eb.cast<number | null>(eb.val(input.maxFailures <= 1 ? lockUntil : null), "bigint"))
            .when("auth_throttle.failures", ">=", input.maxFailures - 1)
            .then(eb.cast<number>(eb.val(lockUntil), "bigint"))
            .else(eb.ref("auth_throttle.locked_until"))
            .end(),
          updated_at: input.now,
        };
      }),
    )
    .returning(["failures", "locked_until"])
    .executeTakeFirstOrThrow();
  return row;
}

/** A successful check removes the row (API §5). */
export async function clearThrottle(q: Queryable, scope: string, keyHash: string): Promise<void> {
  await q.deleteFrom("auth_throttle").where("scope", "=", scope).where("key_hash", "=", keyHash).execute();
}

// ---------------------------------------------------------------------------------------------------------------------
// Export (API §4.5): keyset pages, each read in its own short db.read by the caller
// ---------------------------------------------------------------------------------------------------------------------

export type TrackRow = Selectable<SyncTracksTable>;
export type LikeRow = Pick<Selectable<SyncLikesTable>, "video_id" | "liked" | "liked_at">;
export type BookmarkRow = Omit<Selectable<SyncBookmarksTable>, "user_id" | "seq" | "clk_at" | "clk_dev">;
export type PlaylistRow = Pick<
  Selectable<SyncPlaylistsTable>,
  "id" | "name" | "browse_id" | "thumbnail_url" | "created_at"
>;
export type PlaylistItemRow = Pick<Selectable<SyncPlaylistItemsTable>, "video_id" | "sort_key" | "added_at">;
export type PlayRow = Pick<
  Selectable<PlayEventsTable>,
  "event_id" | "video_id" | "played_at" | "play_time_ms" | "device_id"
>;
export type PlayStatRow = Pick<Selectable<PlayStatsTable>, "video_id" | "total_ms" | "last_played_at">;
export type PlayForgetRow = Pick<Selectable<PlayForgetsTable>, "video_id" | "events_before" | "total_before">;
export type PlaybackRow = Selectable<PlaybackStateTable>;

/** Every track of the user, by `video_id`. */
export async function exportTracksPage(
  q: Queryable,
  userId: string,
  afterVideoId: string | null,
  limit: number,
): Promise<TrackRow[]> {
  let query = q.selectFrom("sync_tracks").selectAll().where("user_id", "=", userId);
  if (afterVideoId !== null) query = query.where("video_id", ">", afterVideoId);
  return query.orderBy("video_id").limit(limit).execute();
}

/** Liked videos only (`liked = 1`), by `video_id`. */
export async function exportLikesPage(
  q: Queryable,
  userId: string,
  afterVideoId: string | null,
  limit: number,
): Promise<LikeRow[]> {
  let query = q
    .selectFrom("sync_likes")
    .select(["video_id", "liked", "liked_at"])
    .where("user_id", "=", userId)
    .where("liked", "=", 1);
  if (afterVideoId !== null) query = query.where("video_id", ">", afterVideoId);
  return query.orderBy("video_id").limit(limit).execute();
}

/** Bookmarked albums and artists only (`bookmarked = 1`), by `(type, browse_id)`. */
export async function exportBookmarksPage(
  q: Queryable,
  userId: string,
  after: Readonly<{ type: string; browseId: string }> | null,
  limit: number,
): Promise<BookmarkRow[]> {
  let query = q
    .selectFrom("sync_bookmarks")
    .select(["type", "browse_id", "bookmarked", "bookmarked_at", "title", "subtitle", "thumbnail_url", "year"])
    .where("user_id", "=", userId)
    .where("bookmarked", "=", 1);
  if (after !== null) {
    query = query.where((eb) => eb(eb.refTuple("type", "browse_id"), ">", eb.tuple(after.type, after.browseId)));
  }
  return query.orderBy("type").orderBy("browse_id").limit(limit).execute();
}

/** Live playlists only (`deleted = 0`), by `(created_at, id)`. */
export async function exportPlaylistsPage(
  q: Queryable,
  userId: string,
  after: Readonly<{ createdAt: number; id: string }> | null,
  limit: number,
): Promise<PlaylistRow[]> {
  let query = q
    .selectFrom("sync_playlists")
    .select(["id", "name", "browse_id", "thumbnail_url", "created_at"])
    .where("user_id", "=", userId)
    .where("deleted", "=", 0);
  if (after !== null) {
    query = query.where((eb) => eb(eb.refTuple("created_at", "id"), ">", eb.tuple(after.createdAt, after.id)));
  }
  return query.orderBy("created_at").orderBy("id").limit(limit).execute();
}

/** Present items of one playlist in playlist order: `ORDER BY sort_key, video_id` (ordinal, API §4.5). */
export async function exportPlaylistItemsPage(
  q: Queryable,
  userId: string,
  playlistId: string,
  after: Readonly<{ sortKey: string; videoId: string }> | null,
  limit: number,
): Promise<PlaylistItemRow[]> {
  let query = q
    .selectFrom("sync_playlist_items")
    .select(["video_id", "sort_key", "added_at"])
    .where("user_id", "=", userId)
    .where("playlist_id", "=", playlistId)
    .where("present", "=", 1);
  if (after !== null) {
    query = query.where((eb) => eb(eb.refTuple("sort_key", "video_id"), ">", eb.tuple(after.sortKey, after.videoId)));
  }
  return query.orderBy("sort_key").orderBy("video_id").limit(limit).execute();
}

/** Plays in the history only (`in_history = 1`), by `(played_at, event_id)`. */
export async function exportPlaysPage(
  q: Queryable,
  userId: string,
  after: Readonly<{ playedAt: number; eventId: string }> | null,
  limit: number,
): Promise<PlayRow[]> {
  let query = q
    .selectFrom("play_events")
    .select(["event_id", "video_id", "played_at", "play_time_ms", "device_id"])
    .where("user_id", "=", userId)
    .where("in_history", "=", 1);
  if (after !== null) {
    query = query.where((eb) => eb(eb.refTuple("played_at", "event_id"), ">", eb.tuple(after.playedAt, after.eventId)));
  }
  return query.orderBy("played_at").orderBy("event_id").limit(limit).execute();
}

/** Play totals, by `video_id`. */
export async function exportPlayStatsPage(
  q: Queryable,
  userId: string,
  afterVideoId: string | null,
  limit: number,
): Promise<PlayStatRow[]> {
  let query = q
    .selectFrom("play_stats")
    .select(["video_id", "total_ms", "last_played_at"])
    .where("user_id", "=", userId);
  if (afterVideoId !== null) query = query.where("video_id", ">", afterVideoId);
  return query.orderBy("video_id").limit(limit).execute();
}

/** History watermarks (`history.clear` / `history.forget`), by `video_id` (`*` sorts first). */
export async function exportPlayForgetsPage(
  q: Queryable,
  userId: string,
  afterVideoId: string | null,
  limit: number,
): Promise<PlayForgetRow[]> {
  let query = q
    .selectFrom("play_forgets")
    .select(["video_id", "events_before", "total_before"])
    .where("user_id", "=", userId);
  if (afterVideoId !== null) query = query.where("video_id", ">", afterVideoId);
  return query.orderBy("video_id").limit(limit).execute();
}

/** The playback state row, also a `cleared` tombstone (the caller maps it to `null`). */
export async function findPlaybackState(q: Queryable, userId: string): Promise<PlaybackRow | undefined> {
  return q.selectFrom("playback_state").selectAll().where("user_id", "=", userId).executeTakeFirst();
}

// ---------------------------------------------------------------------------------------------------------------------
// account-purge (DESIGN §4.11): batches of at most DELETE_BATCH_ROWS rows, each in its own db.write
// ---------------------------------------------------------------------------------------------------------------------

/** Deleted accounts in `(deleted_at, id)` order (partial index `users_deleted`), after the given one. */
export async function listDeletedUsers(
  q: Queryable,
  after: Readonly<{ deletedAt: number; id: string }> | null,
  limit: number,
): Promise<Readonly<{ id: string; deleted_at: number }>[]> {
  let query = q
    .selectFrom("users")
    .select(["id", "deleted_at"])
    .where("deleted_at", "is not", null)
    .$narrowType<{ deleted_at: number }>();
  if (after !== null) {
    query = query.where((eb) => eb(eb.refTuple("deleted_at", "id"), ">", eb.tuple(after.deletedAt, after.id)));
  }
  return query.orderBy("deleted_at").orderBy("id").limit(limit).execute();
}

/**
 * The tables a purge empties, children before parents, with the key that identifies a row within one user. The
 * `users` row and `sync_heads` go last ({@link deleteDeletedUser}); by then these tables are empty for the user and
 * the cascade of `users` has nothing left to do.
 */
export const PURGE_TABLES = Object.freeze([
  { table: "sync_playlist_items", key: ["playlist_id", "video_id"] },
  { table: "sync_playlists", key: ["id"] },
  { table: "sync_tracks", key: ["video_id"] },
  { table: "sync_likes", key: ["video_id"] },
  { table: "sync_bookmarks", key: ["type", "browse_id"] },
  { table: "sync_ops", key: ["seq"] },
  { table: "play_events", key: ["event_id"] },
  { table: "play_stats", key: ["video_id"] },
  { table: "play_forgets", key: ["video_id"] },
  { table: "playback_state", key: ["user_id"] },
  { table: "device_links", key: ["id"] },
  { table: "refresh_tokens", key: ["id"] },
  { table: "devices", key: ["id"] },
] as const satisfies readonly Readonly<{ table: keyof Database; key: readonly string[] }>[]);

export type PurgeTable = (typeof PURGE_TABLES)[number]["table"];

/**
 * Deletes at most `limit` rows of the user from one table:
 * `DELETE FROM t WHERE user_id = ? AND (key…) IN (SELECT key… FROM t WHERE user_id = ? LIMIT ?)`.
 * Table and column names are code constants ({@link PURGE_TABLES}); values are parameters.
 * @returns the number of deleted rows.
 */
export async function purgeBatch(q: Queryable, table: PurgeTable, userId: string, limit: number): Promise<number> {
  const spec = PURGE_TABLES.find((item) => item.table === table);
  if (!spec) throw new Error(`unknown purge table ${table}`);
  const key = sql.join(spec.key.map((column) => sql.ref(column)));
  const result =
    await sql`DELETE FROM ${sql.table(table)} WHERE user_id = ${userId} AND (${key}) IN (SELECT ${key} FROM ${sql.table(table)} WHERE user_id = ${userId} LIMIT ${limit})`.execute(
      q,
    );
  return Number(result.numAffectedRows ?? 0n);
}

/**
 * The last step of a purge: the head and the `users` row of a deleted account (anything a straggling write left in
 * the child tables goes by `ON DELETE CASCADE`).
 * @returns whether the `users` row was deleted.
 */
export async function deleteDeletedUser(q: Queryable, userId: string): Promise<boolean> {
  await q.deleteFrom("sync_heads").where("user_id", "=", userId).execute();
  const result = await q
    .deleteFrom("users")
    .where("id", "=", userId)
    .where("deleted_at", "is not", null)
    .executeTakeFirst();
  return result.numDeletedRows === 1n;
}
