/**
 * The rows of a `POST /sync` response (DESIGN §3.8 `readPage`, "Состав ответа"), read in **one** `db.read` snapshot
 * together with the head, after the ops committed:
 *
 * 1. **the page** ({@link readPage}): per stream, one keyset query per table,
 *    `WHERE user_id = ? AND seq > since AND seq <= head ORDER BY seq LIMIT n + 1` (a `UNION ALL` with `LIMIT` in its
 *    branches is not portable), merged in TS by `seq`. `library` gets up to `limit` rows, `history` the rest of the
 *    budget. A stream read to its end gets the cursor `head.seq`, otherwise the `seq` of its last row;
 * 2. **forced rows** ({@link readForcedRows}): the current rows of every key the ops touched (at any status) and of
 *    `include`;
 * 3. **parents** of the items in the response whose playlist row is newer than the page (`seq > libEnd`): the client
 *    already has older ones, and the page carries the ones in between;
 * 4. **tracks** of the present items, liked likes, plays and play stats of the response.
 *
 * Every key appears once, always as its full current image (all reads see one snapshot, so a page row and a forced
 * row of the same key are the same row). Arrays are ordered by `seq`, `tracks` by `videoId` (API §4.8).
 */
import type { Selectable } from "kysely";
import type {
  BookmarkRow,
  LikeRow,
  LyricsPinRow,
  PlayForgetRow,
  PlaylistItemRow,
  PlaylistRow,
  PlayRow,
  PlayStatRow,
  SyncResponse,
  SyncStream,
  TrackOverrideRow,
} from "../../contract/sync.ts";
import { selectInChunks } from "../../db/batch.ts";
import { fromDbBool } from "../../db/codecs.ts";
import type { Queryable } from "../../db/index.ts";
import type {
  PlayEventsTable,
  PlayForgetsTable,
  PlayStatsTable,
  SyncBookmarksTable,
  SyncLikesTable,
  SyncLyricsPinsTable,
  SyncPlaylistItemsTable,
  SyncPlaylistsTable,
  SyncTrackOverridesTable,
} from "../../db/types.ts";
import { formatIso, formatIsoOrNull } from "../../lib/time.ts";
import type { CursorPosition } from "./cursor.ts";
import { bookmarkKey, itemKey } from "./ops/types.ts";
import type { TouchedKeys } from "./ops/types.ts";
import { readTrackRows, toTrackDto, TRACK_COLUMNS } from "./tracks.ts";
import type { TrackRow } from "./tracks.ts";

// ---------------------------------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------------------------------

const PLAYLIST_COLUMNS = ["id", "name", "browse_id", "thumbnail_url", "created_at", "deleted", "seq"] as const;
const ITEM_COLUMNS = ["playlist_id", "video_id", "present", "sort_key", "added_at", "seq"] as const;
const LIKE_COLUMNS = ["video_id", "liked", "liked_at", "seq"] as const;
const BOOKMARK_COLUMNS = [
  "type",
  "browse_id",
  "bookmarked",
  "bookmarked_at",
  "title",
  "subtitle",
  "thumbnail_url",
  "year",
  "seq",
] as const;
const OVERRIDE_COLUMNS = ["video_id", "title", "artists_text", "album_title", "updated_at", "deleted", "seq"] as const;
const PIN_COLUMNS = ["video_id", "source", "ref", "start_time_ms", "updated_at", "deleted", "seq"] as const;
const PLAY_COLUMNS = ["event_id", "video_id", "played_at", "play_time_ms", "device_id", "seq"] as const;
const STAT_COLUMNS = ["video_id", "total_ms", "last_played_at", "seq"] as const;
const FORGET_COLUMNS = ["video_id", "events_before", "total_before", "seq"] as const;

export type PlaylistDbRow = Pick<Selectable<SyncPlaylistsTable>, (typeof PLAYLIST_COLUMNS)[number]>;
export type ItemDbRow = Pick<Selectable<SyncPlaylistItemsTable>, (typeof ITEM_COLUMNS)[number]>;
export type LikeDbRow = Pick<Selectable<SyncLikesTable>, (typeof LIKE_COLUMNS)[number]>;
export type BookmarkDbRow = Pick<Selectable<SyncBookmarksTable>, (typeof BOOKMARK_COLUMNS)[number]>;
export type OverrideDbRow = Pick<Selectable<SyncTrackOverridesTable>, (typeof OVERRIDE_COLUMNS)[number]>;
export type PinDbRow = Pick<Selectable<SyncLyricsPinsTable>, (typeof PIN_COLUMNS)[number]>;
/** `play_events` rows of the history stream always have a `seq`. */
export type PlayDbRow = Omit<Pick<Selectable<PlayEventsTable>, (typeof PLAY_COLUMNS)[number]>, "seq"> & {
  seq: number;
};
export type StatDbRow = Pick<Selectable<PlayStatsTable>, (typeof STAT_COLUMNS)[number]>;
export type ForgetDbRow = Pick<Selectable<PlayForgetsTable>, (typeof FORGET_COLUMNS)[number]>;

/** The rows of one response by entity key: adding a key twice keeps one row. */
export type ResponseRows = Readonly<{
  playlists: Map<string, PlaylistDbRow>;
  items: Map<string, ItemDbRow>;
  likes: Map<string, LikeDbRow>;
  bookmarks: Map<string, BookmarkDbRow>;
  overrides: Map<string, OverrideDbRow>;
  lyricsPins: Map<string, PinDbRow>;
  tracks: Map<string, TrackRow>;
  plays: Map<string, PlayDbRow>;
  playStats: Map<string, StatDbRow>;
  playForgets: Map<string, ForgetDbRow>;
}>;

export function newResponseRows(): ResponseRows {
  return Object.freeze({
    playlists: new Map(),
    items: new Map(),
    likes: new Map(),
    bookmarks: new Map(),
    overrides: new Map(),
    lyricsPins: new Map(),
    tracks: new Map(),
    plays: new Map(),
    playStats: new Map(),
    playForgets: new Map(),
  });
}

const add = {
  playlist: (rows: ResponseRows, row: PlaylistDbRow) => rows.playlists.set(row.id, row),
  item: (rows: ResponseRows, row: ItemDbRow) => rows.items.set(itemKey(row.playlist_id, row.video_id), row),
  like: (rows: ResponseRows, row: LikeDbRow) => rows.likes.set(row.video_id, row),
  bookmark: (rows: ResponseRows, row: BookmarkDbRow) => rows.bookmarks.set(bookmarkKey(row.type, row.browse_id), row),
  override: (rows: ResponseRows, row: OverrideDbRow) => rows.overrides.set(row.video_id, row),
  pin: (rows: ResponseRows, row: PinDbRow) => rows.lyricsPins.set(row.video_id, row),
  track: (rows: ResponseRows, row: TrackRow) => rows.tracks.set(row.video_id, row),
  play: (rows: ResponseRows, row: PlayDbRow) => rows.plays.set(row.event_id, row),
  stat: (rows: ResponseRows, row: StatDbRow) => rows.playStats.set(row.video_id, row),
  forget: (rows: ResponseRows, row: ForgetDbRow) => rows.playForgets.set(row.video_id, row),
};

// ---------------------------------------------------------------------------------------------------------------------
// 1. The page
// ---------------------------------------------------------------------------------------------------------------------

/** A row read for the page, with the function that adds it to the response. */
type PageRow = Readonly<{ seq: number; take: (rows: ResponseRows) => void }>;

/** One table of a stream: rows with `after < seq <= head`, ordered by `seq`, at most `limit`. */
type StreamSource = (after: number, head: number, limit: number) => Promise<PageRow[]>;

function librarySources(q: Queryable, userId: string): StreamSource[] {
  const tag =
    <R extends { seq: number }>(adder: (rows: ResponseRows, row: R) => unknown) =>
    (row: R): PageRow => ({ seq: row.seq, take: (rows) => void adder(rows, row) });
  return [
    async (after, head, limit) =>
      (
        await q
          .selectFrom("sync_playlists")
          .select(PLAYLIST_COLUMNS)
          .where("user_id", "=", userId)
          .where("seq", ">", after)
          .where("seq", "<=", head)
          .orderBy("seq")
          .limit(limit)
          .execute()
      ).map(tag(add.playlist)),
    async (after, head, limit) =>
      (
        await q
          .selectFrom("sync_playlist_items")
          .select(ITEM_COLUMNS)
          .where("user_id", "=", userId)
          .where("seq", ">", after)
          .where("seq", "<=", head)
          .orderBy("seq")
          .limit(limit)
          .execute()
      ).map(tag(add.item)),
    async (after, head, limit) =>
      (
        await q
          .selectFrom("sync_likes")
          .select(LIKE_COLUMNS)
          .where("user_id", "=", userId)
          .where("seq", ">", after)
          .where("seq", "<=", head)
          .orderBy("seq")
          .limit(limit)
          .execute()
      ).map(tag(add.like)),
    async (after, head, limit) =>
      (
        await q
          .selectFrom("sync_bookmarks")
          .select(BOOKMARK_COLUMNS)
          .where("user_id", "=", userId)
          .where("seq", ">", after)
          .where("seq", "<=", head)
          .orderBy("seq")
          .limit(limit)
          .execute()
      ).map(tag(add.bookmark)),
    async (after, head, limit) =>
      (
        await q
          .selectFrom("sync_tracks")
          .select(TRACK_COLUMNS)
          .where("user_id", "=", userId)
          .where("seq", ">", after)
          .where("seq", "<=", head)
          .orderBy("seq")
          .limit(limit)
          .execute()
      ).map(tag(add.track)),
    async (after, head, limit) =>
      (
        await q
          .selectFrom("sync_track_overrides")
          .select(OVERRIDE_COLUMNS)
          .where("user_id", "=", userId)
          .where("seq", ">", after)
          .where("seq", "<=", head)
          .orderBy("seq")
          .limit(limit)
          .execute()
      ).map(tag(add.override)),
    async (after, head, limit) =>
      (
        await q
          .selectFrom("sync_lyrics_pins")
          .select(PIN_COLUMNS)
          .where("user_id", "=", userId)
          .where("seq", ">", after)
          .where("seq", "<=", head)
          .orderBy("seq")
          .limit(limit)
          .execute()
      ).map(tag(add.pin)),
  ];
}

function historySources(q: Queryable, userId: string): StreamSource[] {
  const tag =
    <R extends { seq: number }>(adder: (rows: ResponseRows, row: R) => unknown) =>
    (row: R): PageRow => ({ seq: row.seq, take: (rows) => void adder(rows, row) });
  return [
    async (after, head, limit) => {
      const events = await q
        .selectFrom("play_events")
        .select(PLAY_COLUMNS)
        .where("user_id", "=", userId)
        .where("seq", ">", after)
        .where("seq", "<=", head)
        .orderBy("seq")
        .limit(limit)
        .execute();
      // `seq > after` excludes NULL, which the type cannot know.
      return events.flatMap((row) => (row.seq === null ? [] : [tag(add.play)({ ...row, seq: row.seq })]));
    },
    async (after, head, limit) =>
      (
        await q
          .selectFrom("play_stats")
          .select(STAT_COLUMNS)
          .where("user_id", "=", userId)
          .where("seq", ">", after)
          .where("seq", "<=", head)
          .orderBy("seq")
          .limit(limit)
          .execute()
      ).map(tag(add.stat)),
    async (after, head, limit) =>
      (
        await q
          .selectFrom("play_forgets")
          .select(FORGET_COLUMNS)
          .where("user_id", "=", userId)
          .where("seq", ">", after)
          .where("seq", "<=", head)
          .orderBy("seq")
          .limit(limit)
          .execute()
      ).map(tag(add.forget)),
  ];
}

type StreamRead = Readonly<{ end: number; exhausted: boolean; count: number }>;

/**
 * Reads up to `budget` rows of one stream after `after` into `rows`. Every table gives up to `budget + 1` rows, so the
 * merge knows whether the stream has more. Seqs are unique across the tables of a user.
 */
async function readStream(
  sources: readonly StreamSource[],
  rows: ResponseRows,
  after: number,
  head: number,
  budget: number,
): Promise<StreamRead> {
  if (after >= head) return { end: head, exhausted: true, count: 0 };
  if (budget <= 0) return { end: after, exhausted: false, count: 0 };
  const read: PageRow[] = [];
  for (const source of sources) read.push(...(await source(after, head, budget + 1)));
  read.sort((a, b) => a.seq - b.seq);
  const taken = read.slice(0, budget);
  for (const row of taken) row.take(rows);
  const exhausted = read.length <= budget;
  const last = taken.at(-1);
  return { end: exhausted || last === undefined ? head : last.seq, exhausted, count: taken.length };
}

export type PageBounds = Readonly<{
  /** Cursor parts after this page (a stream that was not requested keeps its part). */
  libEnd: number;
  histEnd: number;
  /** A requested stream has more rows. */
  hasMore: boolean;
}>;

/** DESIGN §3.8 `readPage`: `library` first, up to `limit` rows, then `history` with the rest of the budget. */
export async function readPage(
  q: Queryable,
  userId: string,
  input: Readonly<{ since: CursorPosition; limit: number; headSeq: number; streams: readonly SyncStream[] }>,
  rows: ResponseRows,
): Promise<PageBounds> {
  const { since, limit, headSeq, streams } = input;
  let budget = limit;
  let libEnd = since.lib;
  let histEnd = since.hist;
  let hasMore = false;
  if (streams.includes("library")) {
    const library = await readStream(librarySources(q, userId), rows, since.lib, headSeq, budget);
    libEnd = library.end;
    hasMore ||= !library.exhausted;
    budget -= library.count;
  }
  if (streams.includes("history")) {
    const history = await readStream(historySources(q, userId), rows, since.hist, headSeq, budget);
    histEnd = history.end;
    hasMore ||= !history.exhausted;
  }
  return Object.freeze({ libEnd, histEnd, hasMore });
}

// ---------------------------------------------------------------------------------------------------------------------
// 2. Forced rows: touched keys and include
// ---------------------------------------------------------------------------------------------------------------------

/** Splits `"<a>:<b>"` at the first `:` (bookmark and item keys, `ops/types.ts`). */
function splitKey(key: string): [string, string] | null {
  const colon = key.indexOf(":");
  return colon <= 0 ? null : [key.slice(0, colon), key.slice(colon + 1)];
}

function groupByFirst(keys: Iterable<string>): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const key of keys) {
    const parts = splitKey(key);
    if (parts === null) continue;
    const list = groups.get(parts[0]) ?? [];
    list.push(parts[1]);
    groups.set(parts[0], list);
  }
  return groups;
}

/** The current rows of `keys` (absent keys have no row and are skipped). */
export async function readForcedRows(
  q: Queryable,
  userId: string,
  keys: TouchedKeys,
  rows: ResponseRows,
): Promise<void> {
  for (const row of await selectInChunks([...keys.likes], (chunk) =>
    q
      .selectFrom("sync_likes")
      .select(LIKE_COLUMNS)
      .where("user_id", "=", userId)
      .where("video_id", "in", chunk)
      .execute(),
  )) {
    add.like(rows, row);
  }
  for (const [type, browseIds] of groupByFirst(keys.bookmarks)) {
    for (const row of await selectInChunks(browseIds, (chunk) =>
      q
        .selectFrom("sync_bookmarks")
        .select(BOOKMARK_COLUMNS)
        .where("user_id", "=", userId)
        .where("type", "=", type)
        .where("browse_id", "in", chunk)
        .execute(),
    )) {
      add.bookmark(rows, row);
    }
  }
  for (const row of await selectInChunks([...keys.overrides], (chunk) =>
    q
      .selectFrom("sync_track_overrides")
      .select(OVERRIDE_COLUMNS)
      .where("user_id", "=", userId)
      .where("video_id", "in", chunk)
      .execute(),
  )) {
    add.override(rows, row);
  }
  for (const row of await selectInChunks([...keys.lyricsPins], (chunk) =>
    q
      .selectFrom("sync_lyrics_pins")
      .select(PIN_COLUMNS)
      .where("user_id", "=", userId)
      .where("video_id", "in", chunk)
      .execute(),
  )) {
    add.pin(rows, row);
  }
  for (const row of await readPlaylists(q, userId, [...keys.playlists])) add.playlist(rows, row);
  for (const [playlistId, videoIds] of groupByFirst(keys.items)) {
    for (const row of await selectInChunks(videoIds, (chunk) =>
      q
        .selectFrom("sync_playlist_items")
        .select(ITEM_COLUMNS)
        .where("user_id", "=", userId)
        .where("playlist_id", "=", playlistId)
        .where("video_id", "in", chunk)
        .execute(),
    )) {
      add.item(rows, row);
    }
  }
  for (const row of await selectInChunks([...keys.playStats], (chunk) =>
    q
      .selectFrom("play_stats")
      .select(STAT_COLUMNS)
      .where("user_id", "=", userId)
      .where("video_id", "in", chunk)
      .execute(),
  )) {
    add.stat(rows, row);
  }
  for (const row of await selectInChunks([...keys.playForgets], (chunk) =>
    q
      .selectFrom("play_forgets")
      .select(FORGET_COLUMNS)
      .where("user_id", "=", userId)
      .where("video_id", "in", chunk)
      .execute(),
  )) {
    add.forget(rows, row);
  }
}

function readPlaylists(q: Queryable, userId: string, ids: readonly string[]): Promise<PlaylistDbRow[]> {
  return selectInChunks(ids, (chunk) =>
    q
      .selectFrom("sync_playlists")
      .select(PLAYLIST_COLUMNS)
      .where("user_id", "=", userId)
      .where("id", "in", chunk)
      .execute(),
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// 3–4. Satellites: parents of items and tracks
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Adds the playlists of the response's items that the client may not have (`seq > libEnd`), then the tracks of the
 * present items, liked likes, plays and play stats.
 */
export async function readSatellites(q: Queryable, userId: string, libEnd: number, rows: ResponseRows): Promise<void> {
  const parents = new Set<string>();
  for (const item of rows.items.values()) if (!rows.playlists.has(item.playlist_id)) parents.add(item.playlist_id);
  for (const row of await readPlaylists(q, userId, [...parents])) if (row.seq > libEnd) add.playlist(rows, row);

  const videoIds = new Set<string>();
  for (const item of rows.items.values()) if (item.present === 1) videoIds.add(item.video_id);
  for (const like of rows.likes.values()) if (like.liked === 1) videoIds.add(like.video_id);
  for (const play of rows.plays.values()) videoIds.add(play.video_id);
  for (const stat of rows.playStats.values()) videoIds.add(stat.video_id);
  for (const known of rows.tracks.keys()) videoIds.delete(known);
  for (const row of await readTrackRows(q, userId, [...videoIds])) add.track(rows, row);
}

// ---------------------------------------------------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------------------------------------------------

function bySeq<R extends { seq: number }>(values: Iterable<R>): R[] {
  return [...values].sort((a, b) => a.seq - b.seq);
}

export function toPlaylistRow(row: PlaylistDbRow): PlaylistRow {
  return {
    id: row.id,
    name: row.name,
    browseId: row.browse_id,
    thumbnailUrl: row.thumbnail_url,
    createdAt: formatIso(row.created_at),
    deleted: fromDbBool(row.deleted),
  };
}

export function toItemRow(row: ItemDbRow): PlaylistItemRow {
  return {
    playlistId: row.playlist_id,
    videoId: row.video_id,
    present: fromDbBool(row.present),
    sortKey: row.sort_key,
    addedAt: formatIso(row.added_at),
  };
}

export function toLikeRow(row: LikeDbRow): LikeRow {
  return { videoId: row.video_id, liked: fromDbBool(row.liked), likedAt: formatIsoOrNull(row.liked_at) };
}

export function toBookmarkRow(row: BookmarkDbRow): BookmarkRow {
  return {
    type: row.type,
    browseId: row.browse_id,
    bookmarked: fromDbBool(row.bookmarked),
    bookmarkedAt: formatIsoOrNull(row.bookmarked_at),
    title: row.title,
    subtitle: row.subtitle,
    thumbnailUrl: row.thumbnail_url,
    year: row.year,
  };
}

export function toTrackOverrideRow(row: OverrideDbRow): TrackOverrideRow {
  return {
    videoId: row.video_id,
    title: row.title,
    artistsText: row.artists_text,
    albumTitle: row.album_title,
    updatedAt: formatIso(row.updated_at),
    deleted: fromDbBool(row.deleted),
  };
}

export function toLyricsPinRow(row: PinDbRow): LyricsPinRow {
  return {
    videoId: row.video_id,
    source: row.source,
    ref: row.ref,
    startTimeMs: row.start_time_ms,
    updatedAt: formatIso(row.updated_at),
    deleted: fromDbBool(row.deleted),
  };
}

export function toPlayRow(row: PlayDbRow): PlayRow {
  return {
    eventId: row.event_id,
    videoId: row.video_id,
    playedAt: formatIso(row.played_at),
    playTimeMs: row.play_time_ms,
    deviceId: row.device_id,
  };
}

export function toPlayStatRow(row: StatDbRow): PlayStatRow {
  return { videoId: row.video_id, totalPlayTimeMs: row.total_ms, lastPlayedAt: formatIsoOrNull(row.last_played_at) };
}

export function toPlayForgetRow(row: ForgetDbRow): PlayForgetRow {
  return {
    videoId: row.video_id,
    eventsBefore: formatIso(row.events_before),
    totalBefore: formatIsoOrNull(row.total_before),
  };
}

export type ResponseArrays = Pick<
  SyncResponse,
  | "tracks"
  | "playlists"
  | "items"
  | "likes"
  | "bookmarks"
  | "overrides"
  | "lyricsPins"
  | "plays"
  | "playStats"
  | "playForgets"
>;

/** The arrays of `SyncResponse`: by `seq`, `tracks` by `videoId` (ordinal). */
export function responseArrays(rows: ResponseRows): ResponseArrays {
  const tracks = [...rows.tracks.values()].sort((a, b) =>
    a.video_id < b.video_id ? -1 : a.video_id > b.video_id ? 1 : 0,
  );
  return {
    tracks: tracks.map(toTrackDto),
    playlists: bySeq(rows.playlists.values()).map(toPlaylistRow),
    items: bySeq(rows.items.values()).map(toItemRow),
    likes: bySeq(rows.likes.values()).map(toLikeRow),
    bookmarks: bySeq(rows.bookmarks.values()).map(toBookmarkRow),
    overrides: bySeq(rows.overrides.values()).map(toTrackOverrideRow),
    lyricsPins: bySeq(rows.lyricsPins.values()).map(toLyricsPinRow),
    plays: bySeq(rows.plays.values()).map(toPlayRow),
    playStats: bySeq(rows.playStats.values()).map(toPlayStatRow),
    playForgets: bySeq(rows.playForgets.values()).map(toPlayForgetRow),
  };
}

/** Empty arrays (a pull at the head). */
export function emptyArrays(): ResponseArrays {
  return {
    tracks: [],
    playlists: [],
    items: [],
    likes: [],
    bookmarks: [],
    overrides: [],
    lyricsPins: [],
    plays: [],
    playStats: [],
    playForgets: [],
  };
}
