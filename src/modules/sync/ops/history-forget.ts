/**
 * `history.forget` (DESIGN §3.7, §3.11.5; API §4.8): «Убрать из Quick Picks» (`resetTotal: false`) and «Скрыть»
 * (`resetTotal: true`, the track stays in the library and its total becomes 0 on every device).
 *
 * ```
 * mark = min(eventsBefore, now)
 * play_forgets[videoId].events_before = max(old, mark)
 * resetTotal: play_forgets[videoId].total_before = max(old, mark)
 * the row changed → new seq; nothing grew → no-op, no seq
 * events_before grew → DELETE the track's in-history events with played_at ≤ mark
 * total_before grew  → play_stats[videoId].total_ms = 0 with a new seq (when it was not 0 already)
 * ```
 *
 * Later plays at or before `total_before` never count again (`play.add`, `play.baseline`); a reset whose mark did not
 * grow changes nothing, so the time of plays after the mark is kept.
 */
import {
  deleteHistoryEvents,
  invalidPayload,
  invalidVideoId,
  isBadVideoId,
  isoField,
  isVideoId,
  readPlayForgets,
  readPlayStats,
  writePlayForget,
  writePlayStats,
} from "./play-add.ts";
import type { PlayForget } from "./play-add.ts";
import { applied, parsed } from "./types.ts";
import type { OpCtx, OpHandler, OpOutcome, OpParseResult, ParsedOp, TouchedKeys, WireOp } from "./types.ts";

export type HistoryForgetOp = ParsedOp & Readonly<{ videoId: string; eventsBefore: number; resetTotal: boolean }>;

export type RaisedForget = Readonly<{
  forget: PlayForget;
  /** `events_before` grew: the track's history up to the mark goes. */
  eventsRaised: boolean;
  /** `total_before` grew: the total becomes 0. */
  totalRaised: boolean;
}>;

/** The track's marks after a forget with `mark = min(eventsBefore, now)`; marks only grow. */
export function raiseForget(current: PlayForget | null, mark: number, resetTotal: boolean): RaisedForget {
  const eventsRaised = current === null || mark > current.eventsBefore;
  const oldTotal = current?.totalBefore ?? null;
  const totalRaised = resetTotal && (oldTotal === null || mark > oldTotal);
  return {
    forget: {
      eventsBefore: current === null || eventsRaised ? mark : current.eventsBefore,
      totalBefore: totalRaised ? mark : oldTotal,
    },
    eventsRaised,
    totalRaised,
  };
}

function parseHistoryForget(raw: WireOp): OpParseResult<HistoryForgetOp> {
  if (isBadVideoId(raw.videoId)) return invalidVideoId();
  const { videoId, resetTotal } = raw;
  const eventsBefore = isoField(raw.eventsBefore);
  if (!isVideoId(videoId) || eventsBefore === null || typeof resetTotal !== "boolean") return invalidPayload();
  return parsed({
    opId: raw.opId,
    kind: "history.forget",
    at: raw.at,
    tracks: undefined,
    trackVideoIds: [],
    videoId,
    eventsBefore,
    resetTotal,
  });
}

async function applyHistoryForget(oc: OpCtx, op: HistoryForgetOp): Promise<OpOutcome> {
  const mark = Math.min(op.eventsBefore, oc.now);
  const current = (await readPlayForgets(oc.q, oc.userId, [op.videoId])).get(op.videoId) ?? null;
  const next = raiseForget(current, mark, op.resetTotal);
  if (!next.eventsRaised && !next.totalRaised) return applied();
  await writePlayForget(oc.q, oc.userId, op.videoId, next.forget, oc.next());
  if (next.eventsRaised) await deleteHistoryEvents(oc, mark, op.videoId);
  if (next.totalRaised) {
    const stat = (await readPlayStats(oc.q, oc.userId, [op.videoId])).get(op.videoId);
    if (stat !== undefined && stat.totalMs !== 0) {
      await writePlayStats(oc.q, oc.userId, [
        { videoId: op.videoId, totalMs: 0, lastPlayedAt: stat.lastPlayedAt, seq: oc.next() },
      ]);
    }
  }
  return applied();
}

function touchHistoryForget(raw: WireOp, touched: TouchedKeys): void {
  if (!isVideoId(raw.videoId)) return;
  touched.playForgets.add(raw.videoId);
  touched.playStats.add(raw.videoId);
}

export const historyForgetHandler: OpHandler<HistoryForgetOp> = Object.freeze({
  kind: "history.forget",
  implemented: true,
  journaled: true,
  parse: parseHistoryForget,
  apply: applyHistoryForget,
  touch: touchHistoryForget,
});
