/**
 * `like.set {videoId, liked, likedAt?, tracks?}` (API §4.8, DESIGN §3.7): one LWW register per videoId in
 * `sync_likes`.
 *
 * - The value is already there (`liked` equals the stored value; no row counts as not liked) → `applied`, nothing
 *   written, no `seq` spent (DESIGN §3.4 "холостая операция").
 * - Otherwise the op must win the register (`wins.ts`), else `superseded`.
 * - A new row needs room under the likes quota (100 000 rows, tombstones included) → else `deferred quota_exceeded`.
 * - Written: `liked`, `liked_at = min(likedAt ?? effAt, now)` for a like (`NULL` for an unlike), the register clock
 *   (`clk_at = effAt`, `clk_dev` = the author) and a new `seq`.
 *
 * A like names its track (`trackVideoIds`): the runner then makes sure the track row exists, a stub when no metadata
 * came. An unlike names none.
 */
import { VIDEO_ID_PATTERN } from "../../../contract/common.ts";
import { toDbBool } from "../../../db/codecs.ts";
import { isOpFailure, optionalIso, requiredBool, requiredVideoId } from "../lenient.ts";
import { LIKES_QUOTA, tryConsume } from "../quotas.ts";
import { wins } from "../wins.ts";
import { applied, deferred, notParsed, parsed, superseded } from "./types.ts";
import type { OpHandler, ParsedOp } from "./types.ts";

export type LikeSetOp = ParsedOp &
  Readonly<{
    videoId: string;
    liked: boolean;
    /** `likedAt` in epoch milliseconds, when the client sent it. */
    likedAt: number | undefined;
  }>;

export const likeSetHandler: OpHandler<LikeSetOp> = Object.freeze({
  kind: "like.set",
  implemented: true,
  journaled: true,

  parse(raw) {
    const videoId = requiredVideoId(raw.videoId);
    if (isOpFailure(videoId)) return notParsed(videoId);
    const liked = requiredBool(raw.liked);
    if (isOpFailure(liked)) return notParsed(liked);
    const likedAt = optionalIso(raw.likedAt);
    if (isOpFailure(likedAt)) return notParsed(likedAt);
    return parsed<LikeSetOp>({
      opId: raw.opId,
      kind: "like.set",
      at: raw.at,
      tracks: raw.tracks,
      trackVideoIds: liked ? [videoId] : [],
      videoId,
      liked,
      likedAt,
    });
  },

  async apply(oc, op, env) {
    const stored = await oc.q
      .selectFrom("sync_likes")
      .select(["liked", "seq", "clk_at", "clk_dev"])
      .where("user_id", "=", oc.userId)
      .where("video_id", "=", op.videoId)
      .executeTakeFirst();
    if ((stored?.liked === 1) === op.liked) return applied();
    const register = stored ? { seq: stored.seq, at: stored.clk_at, dev: stored.clk_dev } : null;
    if (!wins(register, { base: env.base, effAt: env.effAt, dev: oc.deviceId })) return superseded();
    if (stored === undefined && !(await tryConsume(oc, LIKES_QUOTA))) return deferred("quota_exceeded");
    const row = {
      liked: toDbBool(op.liked),
      liked_at: op.liked ? Math.min(op.likedAt ?? env.effAt, oc.now) : null,
      seq: oc.next(),
      clk_at: env.effAt,
      clk_dev: oc.deviceId,
    };
    await oc.q
      .insertInto("sync_likes")
      .values({ user_id: oc.userId, video_id: op.videoId, ...row })
      .onConflict((conflict) => conflict.columns(["user_id", "video_id"]).doUpdateSet(row))
      .execute();
    return applied();
  },

  touch(raw, touched) {
    if (typeof raw.videoId === "string" && VIDEO_ID_PATTERN.test(raw.videoId)) touched.likes.add(raw.videoId);
  },
});
