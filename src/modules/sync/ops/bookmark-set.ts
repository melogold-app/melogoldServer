/**
 * `bookmark.set {type, browseId, bookmarked, bookmarkedAt?, title?, subtitle?, thumbnailUrl?, year?}` (API §4.8,
 * DESIGN §3.7): one LWW register per `(type, browseId)` in `sync_bookmarks`, with a snapshot of the album's or
 * artist's metadata.
 *
 * - `type` is `album` or `artist`, `browseId` a `BrowseId`, `bookmarked` a boolean; otherwise
 *   `deferred invalid_payload`. The metadata is cleaned leniently (`lenient.ts`) and never refuses the op.
 * - The new image: `bookmarked`; `bookmarked_at` kept while the bookmark stays, `min(bookmarkedAt ?? effAt, now)` when
 *   it is set, `NULL` when it is removed; each metadata field the op carries replaces the stored one, a field it does
 *   not carry keeps its value (an unbookmark usually carries none).
 * - The image equals the stored row (no row counts as not bookmarked) → `applied`, nothing written, no `seq` spent.
 * - Otherwise the op must win the register ("метаданные обновляются при победе"), else `superseded`.
 * - A new row needs room under the quota of its type (20 000 rows) → else `deferred quota_exceeded`.
 */
import { BROWSE_ID_PATTERN } from "../../../contract/common.ts";
import { BOOKMARK_TYPE_VALUES } from "../../../contract/sync.ts";
import type { BookmarkType } from "../../../contract/sync.ts";
import { toDbBool } from "../../../db/codecs.ts";
import {
  isOpFailure,
  optionalIso,
  parseBookmarkMeta,
  requiredBool,
  requiredBrowseId,
  requiredEnum,
} from "../lenient.ts";
import type { BookmarkMeta } from "../lenient.ts";
import { bookmarksQuota, tryConsume } from "../quotas.ts";
import { wins } from "../wins.ts";
import { applied, bookmarkKey, deferred, notParsed, parsed, superseded } from "./types.ts";
import type { OpHandler, ParsedOp } from "./types.ts";

export type BookmarkSetOp = ParsedOp &
  Readonly<{
    type: BookmarkType;
    browseId: string;
    bookmarked: boolean;
    /** `bookmarkedAt` in epoch milliseconds, when the client sent it. */
    bookmarkedAt: number | undefined;
    meta: BookmarkMeta;
  }>;

export const bookmarkSetHandler: OpHandler<BookmarkSetOp> = Object.freeze({
  kind: "bookmark.set",
  implemented: true,
  journaled: true,

  parse(raw) {
    const type = requiredEnum(raw.type, BOOKMARK_TYPE_VALUES);
    if (isOpFailure(type)) return notParsed(type);
    const browseId = requiredBrowseId(raw.browseId);
    if (isOpFailure(browseId)) return notParsed(browseId);
    const bookmarked = requiredBool(raw.bookmarked);
    if (isOpFailure(bookmarked)) return notParsed(bookmarked);
    const bookmarkedAt = optionalIso(raw.bookmarkedAt);
    if (isOpFailure(bookmarkedAt)) return notParsed(bookmarkedAt);
    return parsed<BookmarkSetOp>({
      opId: raw.opId,
      kind: "bookmark.set",
      at: raw.at,
      tracks: undefined,
      trackVideoIds: [],
      type,
      browseId,
      bookmarked,
      bookmarkedAt,
      meta: parseBookmarkMeta(raw),
    });
  },

  async apply(oc, op, env) {
    const stored = await oc.q
      .selectFrom("sync_bookmarks")
      .select(["bookmarked", "bookmarked_at", "title", "subtitle", "thumbnail_url", "year", "seq", "clk_at", "clk_dev"])
      .where("user_id", "=", oc.userId)
      .where("type", "=", op.type)
      .where("browse_id", "=", op.browseId)
      .executeTakeFirst();
    if (stored === undefined && !op.bookmarked) return applied();
    const wasBookmarked = stored?.bookmarked === 1;
    const image = {
      bookmarked: toDbBool(op.bookmarked),
      bookmarked_at: !op.bookmarked
        ? null
        : wasBookmarked
          ? (stored.bookmarked_at ?? null)
          : Math.min(op.bookmarkedAt ?? env.effAt, oc.now),
      title: op.meta.title ?? stored?.title ?? null,
      subtitle: op.meta.subtitle ?? stored?.subtitle ?? null,
      thumbnail_url: op.meta.thumbnailUrl ?? stored?.thumbnail_url ?? null,
      year: op.meta.year ?? stored?.year ?? null,
    };
    if (stored !== undefined) {
      const unchanged =
        stored.bookmarked === image.bookmarked &&
        stored.bookmarked_at === image.bookmarked_at &&
        stored.title === image.title &&
        stored.subtitle === image.subtitle &&
        stored.thumbnail_url === image.thumbnail_url &&
        stored.year === image.year;
      if (unchanged) return applied();
    }
    const register = stored ? { seq: stored.seq, at: stored.clk_at, dev: stored.clk_dev } : null;
    if (!wins(register, { base: env.base, effAt: env.effAt, dev: oc.deviceId })) return superseded();
    if (stored === undefined && !(await tryConsume(oc, bookmarksQuota(op.type)))) return deferred("quota_exceeded");
    const row = { ...image, seq: oc.next(), clk_at: env.effAt, clk_dev: oc.deviceId };
    await oc.q
      .insertInto("sync_bookmarks")
      .values({ user_id: oc.userId, type: op.type, browse_id: op.browseId, ...row })
      .onConflict((conflict) => conflict.columns(["user_id", "type", "browse_id"]).doUpdateSet(row))
      .execute();
    return applied();
  },

  touch(raw, touched) {
    const { type, browseId } = raw;
    if (
      typeof type === "string" &&
      (BOOKMARK_TYPE_VALUES as readonly string[]).includes(type) &&
      typeof browseId === "string" &&
      BROWSE_ID_PATTERN.test(browseId)
    ) {
      touched.bookmarks.add(bookmarkKey(type, browseId));
    }
  },
});
