/**
 * `lyrics.pin.set {videoId, source?, ref?, startTimeMs?}` (API §4.8, DESIGN §3.7): lyrics found automatically that
 * the user kept, one LWW register per videoId in `sync_lyrics_pins`. The server stores only the reference to the
 * lyrics at the provider; it never fetches or stores the text.
 *
 * - The op replaces the whole pin: `source` must be one of `youtube_music | lrclib | kugou`, `ref` is trimmed and cut
 *   to 200. A blank `ref` or an unknown `source` → the pin is removed (`deleted`, fields `NULL`). `startTimeMs` out of
 *   0..86 400 000 or mistyped → `NULL`.
 * - Equal value, `wins`, quota (150 000 rows, tombstones included) and the written row as in `track.override.set`.
 */
import { VIDEO_ID_PATTERN } from "../../../contract/common.ts";
import { STRING_LIMITS } from "../../../contract/limits.ts";
import { LYRICS_LIMITS } from "../../../contract/lyrics.ts";
import { LYRICS_PIN_SOURCE_VALUES } from "../../../contract/sync.ts";
import type { LyricsPinSource } from "../../../contract/sync.ts";
import { toDbBool } from "../../../db/codecs.ts";
import { cleanInt, cleanTrimmedText, isOpFailure, requiredVideoId } from "../lenient.ts";
import { LYRICS_PINS_QUOTA, tryConsume } from "../quotas.ts";
import { wins } from "../wins.ts";
import { applied, deferred, notParsed, parsed, superseded } from "./types.ts";
import type { OpHandler, ParsedOp } from "./types.ts";

/** A pin, or `null` fields for a removal. */
export type LyricsPinSetOp = ParsedOp &
  Readonly<{
    videoId: string;
    source: LyricsPinSource | null;
    ref: string | null;
    startTimeMs: number | null;
  }>;

function pinSource(value: unknown): LyricsPinSource | null {
  return LYRICS_PIN_SOURCE_VALUES.find((source) => source === value) ?? null;
}

export const lyricsPinSetHandler: OpHandler<LyricsPinSetOp> = Object.freeze({
  kind: "lyrics.pin.set",
  implemented: true,
  journaled: true,

  parse(raw) {
    const videoId = requiredVideoId(raw.videoId);
    if (isOpFailure(videoId)) return notParsed(videoId);
    const source = pinSource(raw.source);
    const ref = cleanTrimmedText(raw.ref, STRING_LIMITS.lyricsRef);
    const pinned = source !== null && ref !== null;
    return parsed<LyricsPinSetOp>({
      opId: raw.opId,
      kind: "lyrics.pin.set",
      at: raw.at,
      tracks: undefined,
      trackVideoIds: [],
      videoId,
      source: pinned ? source : null,
      ref: pinned ? ref : null,
      startTimeMs: pinned ? cleanInt(raw.startTimeMs, 0, LYRICS_LIMITS.startTimeMaxMs) : null,
    });
  },

  async apply(oc, op, env) {
    const deleted = op.source === null;
    const stored = await oc.q
      .selectFrom("sync_lyrics_pins")
      .select(["source", "ref", "start_time_ms", "deleted", "seq", "clk_at", "clk_dev"])
      .where("user_id", "=", oc.userId)
      .where("video_id", "=", op.videoId)
      .executeTakeFirst();
    const storedDeleted = stored === undefined || stored.deleted === 1;
    const same = deleted
      ? storedDeleted
      : !storedDeleted &&
        stored.source === op.source &&
        stored.ref === op.ref &&
        stored.start_time_ms === op.startTimeMs;
    if (same) return applied();
    const register = stored ? { seq: stored.seq, at: stored.clk_at, dev: stored.clk_dev } : null;
    if (!wins(register, { base: env.base, effAt: env.effAt, dev: oc.deviceId })) return superseded();
    if (stored === undefined && !(await tryConsume(oc, LYRICS_PINS_QUOTA))) return deferred("quota_exceeded");
    const row = {
      source: op.source,
      ref: op.ref,
      start_time_ms: op.startTimeMs,
      updated_at: env.effAt,
      seq: oc.next(),
      deleted: toDbBool(deleted),
      clk_at: env.effAt,
      clk_dev: oc.deviceId,
    };
    await oc.q
      .insertInto("sync_lyrics_pins")
      .values({ user_id: oc.userId, video_id: op.videoId, ...row })
      .onConflict((conflict) => conflict.columns(["user_id", "video_id"]).doUpdateSet(row))
      .execute();
    return applied();
  },

  touch(raw, touched) {
    if (typeof raw.videoId === "string" && VIDEO_ID_PATTERN.test(raw.videoId)) touched.lyricsPins.add(raw.videoId);
  },
});
