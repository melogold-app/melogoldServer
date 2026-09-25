/**
 * `lyrics` (API §9.2 `0006_lyrics`): at most one row per user and video. Every write runs under `lockUser` of the
 * author (docs/database.md §2.5), so `rev` = max + 1 cannot race.
 */
import { fromDbBool, toDbBool } from "../../db/codecs.ts";
import type { Queryable } from "../../db/index.ts";

/** The text of a version; every field null on a tombstone. */
export type LyricsContent = Readonly<{
  plain: string | null;
  plainSource: string | null;
  synced: string | null;
  syncedFormat: string | null;
  syncedSource: string | null;
  startTimeMs: number | null;
  language: string | null;
}>;

export type StoredLyrics = Readonly<{
  id: string;
  userId: string;
  videoId: string;
  rev: number;
  deleted: boolean;
  content: LyricsContent;
  createdAt: number;
  updatedAt: number;
}>;

type LyricsRow = {
  id: string;
  user_id: string;
  video_id: string;
  rev: number;
  deleted: 0 | 1;
  plain: string | null;
  plain_source: string | null;
  synced: string | null;
  synced_format: string | null;
  synced_source: string | null;
  start_time_ms: number | null;
  language: string | null;
  created_at: number;
  updated_at: number;
};

function fromRow(row: LyricsRow): StoredLyrics {
  return Object.freeze({
    id: row.id,
    userId: row.user_id,
    videoId: row.video_id,
    rev: row.rev,
    deleted: fromDbBool(row.deleted),
    content: Object.freeze({
      plain: row.plain,
      plainSource: row.plain_source,
      synced: row.synced,
      syncedFormat: row.synced_format,
      syncedSource: row.synced_source,
      startTimeMs: row.start_time_ms,
      language: row.language,
    }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

/** The user's version of a video, tombstone included; `null` when there never was one. */
export async function findUserLyrics(q: Queryable, userId: string, videoId: string): Promise<StoredLyrics | null> {
  const row = await q
    .selectFrom("lyrics")
    .selectAll()
    .where("user_id", "=", userId)
    .where("video_id", "=", videoId)
    .executeTakeFirst();
  return row ? fromRow(row) : null;
}

/** The largest `rev` of the user, 0 when they have no lyrics. */
export async function maxUserRev(q: Queryable, userId: string): Promise<number> {
  const row = await q
    .selectFrom("lyrics")
    .select((eb) => eb.fn.coalesce(eb.fn.max("rev"), eb.lit(0)).as("rev"))
    .where("user_id", "=", userId)
    .executeTakeFirst();
  return row?.rev ?? 0;
}

/** Inserts the version, or replaces the user's one for this video (keeping its `id` and `created_at`). */
export async function upsertUserLyrics(q: Queryable, lyrics: StoredLyrics): Promise<void> {
  const { content } = lyrics;
  const changes = {
    rev: lyrics.rev,
    deleted: toDbBool(lyrics.deleted),
    plain: content.plain,
    plain_source: content.plainSource,
    synced: content.synced,
    synced_format: content.syncedFormat,
    synced_source: content.syncedSource,
    start_time_ms: content.startTimeMs,
    language: content.language,
    updated_at: lyrics.updatedAt,
  };
  await q
    .insertInto("lyrics")
    .values({
      id: lyrics.id,
      user_id: lyrics.userId,
      video_id: lyrics.videoId,
      created_at: lyrics.createdAt,
      ...changes,
    })
    .onConflict((oc) => oc.columns(["user_id", "video_id"]).doUpdateSet(changes))
    .execute();
}

/**
 * The version other users see (API §4.10 `shared`): not deleted, not the caller's; first with synced lyrics, then
 * with plain lyrics only; the most recent of them.
 */
export async function findSharedLyrics(
  q: Queryable,
  videoId: string,
  exceptUserId: string,
): Promise<StoredLyrics | null> {
  for (const column of ["synced", "plain"] as const) {
    const row = await q
      .selectFrom("lyrics")
      .selectAll()
      .where("video_id", "=", videoId)
      .where("deleted", "=", 0)
      .where("user_id", "!=", exceptUserId)
      .where(column, "is not", null)
      .orderBy("updated_at", "desc")
      .orderBy("id", "asc")
      .limit(1)
      .executeTakeFirst();
    if (row) return fromRow(row);
  }
  return null;
}

/** The user's versions with `rev > after`, ascending, at most `limit`; tombstones only when asked for. */
export async function listUserChanges(
  q: Queryable,
  userId: string,
  after: number,
  limit: number,
  withTombstones: boolean,
): Promise<StoredLyrics[]> {
  let query = q.selectFrom("lyrics").selectAll().where("user_id", "=", userId).where("rev", ">", after);
  if (!withTombstones) query = query.where("deleted", "=", 0);
  const rows = await query.orderBy("rev", "asc").limit(limit).execute();
  return rows.map(fromRow);
}
