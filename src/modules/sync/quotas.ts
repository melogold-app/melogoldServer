/**
 * Quotas of the sync state (DESIGN §3.10, API §11 `ServerLimits.sync`). There are no stored counters that could drift
 * from the data: each quota is a `COUNT(*)` over its rows, run **once per request** at the first need and then kept in
 * memory by `oc.counters` (`createRequestCounters`), adjusted by every row the request creates or removes.
 *
 * | Quota                          | Limit   | Rows counted                               | Over the limit                         |
 * | ------------------------------ | ------- | ------------------------------------------ | -------------------------------------- |
 * | {@link LIKES_QUOTA}            | 100 000 | `sync_likes` (tombstones included)         | `deferred quota_exceeded`              |
 * | {@link bookmarksQuota}(type)   | 20 000  | `sync_bookmarks` of the type               | `deferred quota_exceeded`              |
 * | {@link LIVE_PLAYLISTS_QUOTA}   | 1000    | `sync_playlists` with `deleted = 0`        | `deferred quota_exceeded`              |
 * | {@link ITEMS_TOTAL_QUOTA}      | 100 000 | `sync_playlist_items` (tombstones included) | `deferred quota_exceeded`              |
 * | {@link playlistItemsQuota}(id) | 10 000  | items of one playlist (tombstones included) | `deferred quota_exceeded`              |
 * | {@link TRACKS_QUOTA}           | 150 000 | `sync_tracks`                              | new metadata is not stored, op applies |
 * | {@link TRACK_OVERRIDES_QUOTA}  | 150 000 | `sync_track_overrides` (tombstones included) | `deferred quota_exceeded`            |
 * | {@link LYRICS_PINS_QUOTA}      | 150 000 | `sync_lyrics_pins` (tombstones included)   | `deferred quota_exceeded`              |
 * | {@link PLAY_STATS_QUOTA}       | 100 000 | `play_stats`                               | no counter for new tracks              |
 * | {@link PLAY_EVENTS_QUOTA}      | 60 000  | `play_events`                              | the oldest events are evicted          |
 *
 * A quota is checked where a row is **created** (a stored row, tombstones included, is never refused an update), so
 * the storage of a user stays bounded. Usage: `if (!(await tryConsume(oc, LIKES_QUOTA))) return deferred("quota_exceeded")`.
 */
import { SYNC_LIMITS } from "../../contract/limits.ts";
import type { Queryable } from "../../db/index.ts";
import type { OpCtx } from "./ops/types.ts";

export type Quota = Readonly<{
  /** Key of `oc.counters`. */
  key: string;
  limit: number;
  /** The `COUNT(*)` of the rows the quota bounds. */
  count(q: Queryable, userId: string): Promise<number>;
}>;

type Counted = Promise<{ rows: string | number | bigint } | undefined>;

async function rows(query: Counted): Promise<number> {
  return Number((await query)?.rows ?? 0);
}

export const LIKES_QUOTA: Quota = Object.freeze({
  key: "likes",
  limit: SYNC_LIMITS.maxLikes,
  count: (q: Queryable, userId: string) =>
    rows(
      q
        .selectFrom("sync_likes")
        .select((eb) => eb.fn.countAll().as("rows"))
        .where("user_id", "=", userId)
        .executeTakeFirst(),
    ),
});

/** Bookmarks of one type (`album`, `artist`). */
export function bookmarksQuota(type: string): Quota {
  return Object.freeze({
    key: `bookmarks:${type}`,
    limit: SYNC_LIMITS.maxBookmarksPerType,
    count: (q: Queryable, userId: string) =>
      rows(
        q
          .selectFrom("sync_bookmarks")
          .select((eb) => eb.fn.countAll().as("rows"))
          .where("user_id", "=", userId)
          .where("type", "=", type)
          .executeTakeFirst(),
      ),
  });
}

export const LIVE_PLAYLISTS_QUOTA: Quota = Object.freeze({
  key: "playlists",
  limit: SYNC_LIMITS.maxPlaylists,
  count: (q: Queryable, userId: string) =>
    rows(
      q
        .selectFrom("sync_playlists")
        .select((eb) => eb.fn.countAll().as("rows"))
        .where("user_id", "=", userId)
        .where("deleted", "=", 0)
        .executeTakeFirst(),
    ),
});

export const ITEMS_TOTAL_QUOTA: Quota = Object.freeze({
  key: "items",
  limit: SYNC_LIMITS.maxItemsTotal,
  count: (q: Queryable, userId: string) =>
    rows(
      q
        .selectFrom("sync_playlist_items")
        .select((eb) => eb.fn.countAll().as("rows"))
        .where("user_id", "=", userId)
        .executeTakeFirst(),
    ),
});

/** Items of one playlist, tombstones included. */
export function playlistItemsQuota(playlistId: string): Quota {
  return Object.freeze({
    key: `items:${playlistId}`,
    limit: SYNC_LIMITS.maxPlaylistItems,
    count: (q: Queryable, userId: string) =>
      rows(
        q
          .selectFrom("sync_playlist_items")
          .select((eb) => eb.fn.countAll().as("rows"))
          .where("user_id", "=", userId)
          .where("playlist_id", "=", playlistId)
          .executeTakeFirst(),
      ),
  });
}

export const TRACK_OVERRIDES_QUOTA: Quota = Object.freeze({
  key: "overrides",
  limit: SYNC_LIMITS.maxTrackOverrides,
  count: (q: Queryable, userId: string) =>
    rows(
      q
        .selectFrom("sync_track_overrides")
        .select((eb) => eb.fn.countAll().as("rows"))
        .where("user_id", "=", userId)
        .executeTakeFirst(),
    ),
});

export const LYRICS_PINS_QUOTA: Quota = Object.freeze({
  key: "lyricsPins",
  limit: SYNC_LIMITS.maxLyricsPins,
  count: (q: Queryable, userId: string) =>
    rows(
      q
        .selectFrom("sync_lyrics_pins")
        .select((eb) => eb.fn.countAll().as("rows"))
        .where("user_id", "=", userId)
        .executeTakeFirst(),
    ),
});

export const TRACKS_QUOTA: Quota = Object.freeze({
  key: "tracks",
  limit: SYNC_LIMITS.maxTracks,
  count: (q: Queryable, userId: string) =>
    rows(
      q
        .selectFrom("sync_tracks")
        .select((eb) => eb.fn.countAll().as("rows"))
        .where("user_id", "=", userId)
        .executeTakeFirst(),
    ),
});

export const PLAY_STATS_QUOTA: Quota = Object.freeze({
  key: "playStats",
  limit: SYNC_LIMITS.maxPlayStats,
  count: (q: Queryable, userId: string) =>
    rows(
      q
        .selectFrom("play_stats")
        .select((eb) => eb.fn.countAll().as("rows"))
        .where("user_id", "=", userId)
        .executeTakeFirst(),
    ),
});

export const PLAY_EVENTS_QUOTA: Quota = Object.freeze({
  key: "playEvents",
  limit: SYNC_LIMITS.maxPlayEvents,
  count: (q: Queryable, userId: string) =>
    rows(
      q
        .selectFrom("play_events")
        .select((eb) => eb.fn.countAll().as("rows"))
        .where("user_id", "=", userId)
        .executeTakeFirst(),
    ),
});

/** Rows of the quota now, as this request sees them (one `COUNT(*)` per request, then in memory). */
export function quotaUsage(oc: Pick<OpCtx, "q" | "userId" | "counters">, quota: Quota): Promise<number> {
  return oc.counters.get(quota.key, () => quota.count(oc.q, oc.userId));
}

/**
 * Reserves `amount` new rows: `true` (and the in-memory counter grows) when they fit under the limit, `false`
 * (nothing reserved) otherwise.
 */
export async function tryConsume(
  oc: Pick<OpCtx, "q" | "userId" | "counters">,
  quota: Quota,
  amount = 1,
): Promise<boolean> {
  const used = await quotaUsage(oc, quota);
  if (used + amount > quota.limit) return false;
  oc.counters.add(quota.key, amount);
  return true;
}

/** Gives back rows the request removed (or reserved and did not create). */
export function release(oc: Pick<OpCtx, "counters">, quota: Quota, amount = 1): void {
  oc.counters.add(quota.key, -amount);
}
