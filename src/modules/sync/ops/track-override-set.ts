/**
 * `track.override.set {videoId, title?, artistsText?, albumTitle?}` (API §4.8, DESIGN §3.7): the user's own text over
 * the YouTube metadata of a track, one LWW register per videoId in `sync_track_overrides`. `sync_tracks` is never
 * touched, so "back to YouTube" always has the original.
 *
 * - The op replaces the whole override: each field is trimmed and cut to 500 (`cleanTrimmedText`); a missing, blank or
 *   mistyped field has no override. All three empty → the override is removed (`deleted`, fields `NULL`).
 * - The stored value is already this one (a removal counts as equal to no row) → `applied`, nothing written, no `seq`.
 * - Otherwise the op must win the register (`wins.ts`), else `superseded`.
 * - A new row needs room under the overrides quota (150 000 rows, tombstones included) → else
 *   `deferred quota_exceeded`.
 * - Written: the fields, `deleted`, `updated_at = effAt`, the register clock and a new `seq`.
 */
import { VIDEO_ID_PATTERN } from "../../../contract/common.ts";
import { STRING_LIMITS } from "../../../contract/limits.ts";
import { toDbBool } from "../../../db/codecs.ts";
import { cleanTrimmedText, isOpFailure, requiredVideoId } from "../lenient.ts";
import { TRACK_OVERRIDES_QUOTA, tryConsume } from "../quotas.ts";
import { wins } from "../wins.ts";
import { applied, deferred, notParsed, parsed, superseded } from "./types.ts";
import type { OpHandler, ParsedOp } from "./types.ts";

export type TrackOverrideSetOp = ParsedOp &
  Readonly<{
    videoId: string;
    title: string | null;
    artistsText: string | null;
    albumTitle: string | null;
  }>;

export const trackOverrideSetHandler: OpHandler<TrackOverrideSetOp> = Object.freeze({
  kind: "track.override.set",
  implemented: true,
  journaled: true,

  parse(raw) {
    const videoId = requiredVideoId(raw.videoId);
    if (isOpFailure(videoId)) return notParsed(videoId);
    return parsed<TrackOverrideSetOp>({
      opId: raw.opId,
      kind: "track.override.set",
      at: raw.at,
      tracks: undefined,
      trackVideoIds: [],
      videoId,
      title: cleanTrimmedText(raw.title, STRING_LIMITS.title),
      artistsText: cleanTrimmedText(raw.artistsText, STRING_LIMITS.title),
      albumTitle: cleanTrimmedText(raw.albumTitle, STRING_LIMITS.title),
    });
  },

  async apply(oc, op, env) {
    const deleted = op.title === null && op.artistsText === null && op.albumTitle === null;
    const stored = await oc.q
      .selectFrom("sync_track_overrides")
      .select(["title", "artists_text", "album_title", "deleted", "seq", "clk_at", "clk_dev"])
      .where("user_id", "=", oc.userId)
      .where("video_id", "=", op.videoId)
      .executeTakeFirst();
    const storedDeleted = stored === undefined || stored.deleted === 1;
    const same = deleted
      ? storedDeleted
      : !storedDeleted &&
        stored.title === op.title &&
        stored.artists_text === op.artistsText &&
        stored.album_title === op.albumTitle;
    if (same) return applied();
    const register = stored ? { seq: stored.seq, at: stored.clk_at, dev: stored.clk_dev } : null;
    if (!wins(register, { base: env.base, effAt: env.effAt, dev: oc.deviceId })) return superseded();
    if (stored === undefined && !(await tryConsume(oc, TRACK_OVERRIDES_QUOTA))) return deferred("quota_exceeded");
    const row = {
      title: op.title,
      artists_text: op.artistsText,
      album_title: op.albumTitle,
      updated_at: env.effAt,
      seq: oc.next(),
      deleted: toDbBool(deleted),
      clk_at: env.effAt,
      clk_dev: oc.deviceId,
    };
    await oc.q
      .insertInto("sync_track_overrides")
      .values({ user_id: oc.userId, video_id: op.videoId, ...row })
      .onConflict((conflict) => conflict.columns(["user_id", "video_id"]).doUpdateSet(row))
      .execute();
    return applied();
  },

  touch(raw, touched) {
    if (typeof raw.videoId === "string" && VIDEO_ID_PATTERN.test(raw.videoId)) touched.overrides.add(raw.videoId);
  },
});
