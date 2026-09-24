/**
 * `sync_tracks`: the metadata of the user's tracks, a row per videoId with its own `seq` in the `library` stream
 * (DESIGN §3.3, m2).
 *
 * {@link upsertTracks} runs after an op handler whose status is neither `deferred` nor `rejected` (DESIGN §3.8):
 * - every videoId the op names (`ParsedOp.trackVideoIds`) gets a row: the cleaned metadata of `tracks[]`
 *   (`lenient.ts`), or a **stub** (`stub = 1`, `title = videoId`, nothing else) when none came or the title is empty;
 * - an existing row is rewritten, with a new `seq`, only by real metadata (not a stub) and only when the stored row
 *   is a stub, `title` or `artistsText` changed, or the stored `durationMs` was unknown and is known now. A new
 *   `thumbnailUrl` alone moves nothing, so two devices with different thumbnails do not ping-pong;
 * - a new row needs room under `TRACKS_QUOTA` (150 000): beyond it the metadata is not stored and the op still
 *   applies (DESIGN §3.10).
 *
 * Decisions are made in TS under `lockUser`; the rows are then written by `INSERT … ON CONFLICT DO UPDATE` in batches
 * of 500 (docs/database.md §4.4).
 */
import type { Insertable, Selectable } from "kysely";
import { z } from "zod";
import type { TrackDto } from "../../contract/common.ts";
import { insertInChunks, selectInChunks } from "../../db/batch.ts";
import { fromDbBool, jsonCodec, toDbBool } from "../../db/codecs.ts";
import type { Queryable } from "../../db/index.ts";
import type { SyncTracksTable } from "../../db/types.ts";
import { parseTrackInputs } from "./lenient.ts";
import type { TrackMeta } from "./lenient.ts";
import type { OpCtx } from "./ops/types.ts";
import { TRACKS_QUOTA, tryConsume } from "./quotas.ts";

/** `sync_tracks.artists`: `ArtistRef[]`; `NULL` when there are none. */
export const artistsCodec = jsonCodec(
  z.array(z.object({ id: z.string().nullable(), name: z.string() })),
  "sync_tracks.artists",
);

type StoredTrack = Pick<Selectable<SyncTracksTable>, "video_id" | "title" | "artists_text" | "duration_ms" | "stub">;

/** Whether real metadata rewrites a stored row (DESIGN §3.3). */
export function metadataReplaces(stored: Omit<StoredTrack, "video_id">, meta: TrackMeta): boolean {
  return (
    stored.stub === 1 ||
    stored.title !== meta.title ||
    stored.artists_text !== meta.artistsText ||
    (stored.duration_ms === null && meta.durationMs !== null)
  );
}

function trackRow(
  userId: string,
  videoId: string,
  meta: TrackMeta | null,
  seq: number,
  now: number,
): Insertable<SyncTracksTable> {
  return {
    user_id: userId,
    video_id: videoId,
    title: meta?.title ?? videoId,
    artists_text: meta?.artistsText ?? null,
    artists: meta && meta.artists.length > 0 ? artistsCodec.encode([...meta.artists]) : null,
    album_id: meta?.albumId ?? null,
    album_title: meta?.albumTitle ?? null,
    duration_ms: meta?.durationMs ?? null,
    duration_text: meta?.durationText ?? null,
    thumbnail_url: meta?.thumbnailUrl ?? null,
    explicit: toDbBool(meta?.explicit ?? false),
    video_type: meta?.videoType ?? null,
    stub: toDbBool(meta === null),
    seq,
    updated_at: now,
  };
}

/**
 * Makes sure every videoId of `videoIds` has a `sync_tracks` row, with the metadata of `rawTracks` where it improves
 * the stored row (see the module comment). Uses `oc.next()` once per written row.
 * @param rawTracks `SyncOp.tracks` as it came (parsed leniently here).
 * @returns the number of rows written.
 */
export async function upsertTracks(
  oc: Pick<OpCtx, "q" | "userId" | "now" | "next" | "counters">,
  rawTracks: unknown,
  videoIds: readonly string[],
): Promise<number> {
  const wanted = [...new Set(videoIds)];
  if (wanted.length === 0) return 0;
  const inputs = parseTrackInputs(rawTracks, new Set(wanted));
  const stored = new Map<string, StoredTrack>();
  const found = await selectInChunks(wanted, (chunk) =>
    oc.q
      .selectFrom("sync_tracks")
      .select(["video_id", "title", "artists_text", "duration_ms", "stub"])
      .where("user_id", "=", oc.userId)
      .where("video_id", "in", chunk)
      .execute(),
  );
  for (const row of found) stored.set(row.video_id, row);

  const writes: Insertable<SyncTracksTable>[] = [];
  for (const videoId of wanted) {
    const meta = inputs.get(videoId) ?? null;
    const row = stored.get(videoId);
    if (row === undefined) {
      if (await tryConsume(oc, TRACKS_QUOTA)) writes.push(trackRow(oc.userId, videoId, meta, oc.next(), oc.now));
    } else if (meta !== null && metadataReplaces(row, meta)) {
      writes.push(trackRow(oc.userId, videoId, meta, oc.next(), oc.now));
    }
  }
  await insertInChunks(writes, (chunk) =>
    oc.q
      .insertInto("sync_tracks")
      .values(chunk)
      .onConflict((conflict) =>
        conflict.columns(["user_id", "video_id"]).doUpdateSet((eb) => ({
          title: eb.ref("excluded.title"),
          artists_text: eb.ref("excluded.artists_text"),
          artists: eb.ref("excluded.artists"),
          album_id: eb.ref("excluded.album_id"),
          album_title: eb.ref("excluded.album_title"),
          duration_ms: eb.ref("excluded.duration_ms"),
          duration_text: eb.ref("excluded.duration_text"),
          thumbnail_url: eb.ref("excluded.thumbnail_url"),
          explicit: eb.ref("excluded.explicit"),
          video_type: eb.ref("excluded.video_type"),
          stub: eb.ref("excluded.stub"),
          seq: eb.ref("excluded.seq"),
          updated_at: eb.ref("excluded.updated_at"),
        })),
      )
      .execute(),
  );
  return writes.length;
}

/** The columns of a `TrackDto`. */
export const TRACK_COLUMNS = [
  "video_id",
  "title",
  "artists_text",
  "artists",
  "album_id",
  "album_title",
  "duration_ms",
  "duration_text",
  "thumbnail_url",
  "explicit",
  "video_type",
  "stub",
  "seq",
] as const;

export type TrackRow = Pick<Selectable<SyncTracksTable>, (typeof TRACK_COLUMNS)[number]>;

export function toTrackDto(row: TrackRow): TrackDto {
  return {
    videoId: row.video_id,
    title: row.title,
    artistsText: row.artists_text,
    artists: artistsCodec.decodeNullable(row.artists) ?? [],
    albumId: row.album_id,
    albumTitle: row.album_title,
    durationMs: row.duration_ms,
    durationText: row.duration_text,
    thumbnailUrl: row.thumbnail_url,
    explicit: fromDbBool(row.explicit),
    videoType: row.video_type,
    metadataStub: fromDbBool(row.stub),
  };
}

/** The stored rows of these videoIds (missing ones are simply absent). */
export function readTrackRows(q: Queryable, userId: string, videoIds: readonly string[]): Promise<TrackRow[]> {
  return selectInChunks(videoIds, (chunk) =>
    q
      .selectFrom("sync_tracks")
      .select(TRACK_COLUMNS)
      .where("user_id", "=", userId)
      .where("video_id", "in", chunk)
      .execute(),
  );
}
