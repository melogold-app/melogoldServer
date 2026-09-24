/**
 * `GET /sync/summary` (API §4.7): what the server holds, for the merge dialog (DESIGN §3.14), with the head cursor —
 * all from one `db.read` snapshot.
 *
 * | Count          | Rows                                                                 |
 * | -------------- | -------------------------------------------------------------------- |
 * | `likes`        | `sync_likes` with `liked = 1`                                         |
 * | `albums`       | `sync_bookmarks` of type `album` with `bookmarked = 1`                |
 * | `artists`      | `sync_bookmarks` of type `artist` with `bookmarked = 1`               |
 * | `playlists`    | live playlists (`deleted = 0`)                                        |
 * | `items`        | present items (items of deleted playlists are deleted physically)     |
 * | `plays`        | history events (`play_events.in_history = 1`)                         |
 * | `playedTracks` | tracks with listening time (`play_stats.total_ms > 0`, DESIGN §3.11.7) |
 */
import type { z } from "zod";
import type { SyncSummary, SyncSummaryCounts } from "../../contract/sync.ts";
import { readHead } from "../../db/heads.ts";
import type { Queryable } from "../../db/index.ts";
import { formatIso } from "../../lib/time.ts";
import { headCursor } from "./cursor.ts";

export type SummaryCounts = z.output<typeof SyncSummaryCounts>;

type Counted = Promise<{ rows: string | number | bigint } | undefined>;

async function rows(query: Counted): Promise<number> {
  return Number((await query)?.rows ?? 0);
}

export async function readSummaryCounts(q: Queryable, userId: string): Promise<SummaryCounts> {
  const bookmarks = (type: string) =>
    rows(
      q
        .selectFrom("sync_bookmarks")
        .select((eb) => eb.fn.countAll().as("rows"))
        .where("user_id", "=", userId)
        .where("type", "=", type)
        .where("bookmarked", "=", 1)
        .executeTakeFirst(),
    );
  return {
    likes: await rows(
      q
        .selectFrom("sync_likes")
        .select((eb) => eb.fn.countAll().as("rows"))
        .where("user_id", "=", userId)
        .where("liked", "=", 1)
        .executeTakeFirst(),
    ),
    albums: await bookmarks("album"),
    artists: await bookmarks("artist"),
    playlists: await rows(
      q
        .selectFrom("sync_playlists")
        .select((eb) => eb.fn.countAll().as("rows"))
        .where("user_id", "=", userId)
        .where("deleted", "=", 0)
        .executeTakeFirst(),
    ),
    items: await rows(
      q
        .selectFrom("sync_playlist_items")
        .select((eb) => eb.fn.countAll().as("rows"))
        .where("user_id", "=", userId)
        .where("present", "=", 1)
        .executeTakeFirst(),
    ),
    plays: await rows(
      q
        .selectFrom("play_events")
        .select((eb) => eb.fn.countAll().as("rows"))
        .where("user_id", "=", userId)
        .where("in_history", "=", 1)
        .executeTakeFirst(),
    ),
    playedTracks: await rows(
      q
        .selectFrom("play_stats")
        .select((eb) => eb.fn.countAll().as("rows"))
        .where("user_id", "=", userId)
        .where("total_ms", ">", 0)
        .executeTakeFirst(),
    ),
  };
}

/** The summary inside `db.read` (the head and the counts come from one snapshot). */
export async function readSummary(q: Queryable, userId: string, now: number): Promise<SyncSummary> {
  const head = await readHead(q, userId);
  const counts = await readSummaryCounts(q, userId);
  return { cursor: headCursor(head), serverTime: formatIso(now), counts };
}
