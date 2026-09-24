/**
 * `history.clear` (DESIGN §3.7, §3.11.5; API §4.8): «Очистить историю».
 *
 * ```
 * mark = min(eventsBefore, now)
 * play_forgets['*'].events_before = max(old, mark)          new seq when it grew; unchanged → no-op, no seq
 * DELETE play_events WHERE in_history = 1 AND played_at ≤ mark   (in batches)
 * ```
 *
 * Totals are not touched, as in ViTune. Other devices delete their events with `timestamp ≤ eventsBefore` when the
 * `'*'` row reaches them; an event played before the mark that arrives later is counted but stays out of the history
 * (`play.add`).
 */
import { ALL_VIDEOS } from "../../../contract/sync.ts";
import { deleteHistoryEvents, invalidPayload, isoField, readPlayForgets, writePlayForget } from "./play-add.ts";
import { applied, parsed } from "./types.ts";
import type { OpCtx, OpHandler, OpOutcome, OpParseResult, ParsedOp, TouchedKeys, WireOp } from "./types.ts";

export type HistoryClearOp = ParsedOp & Readonly<{ eventsBefore: number }>;

/** The `'*'` mark after a clear with `mark = min(eventsBefore, now)`; `null` when it does not grow (a no-op). */
export function raiseClearMark(current: number | null, mark: number): number | null {
  return current === null || mark > current ? mark : null;
}

function parseHistoryClear(raw: WireOp): OpParseResult<HistoryClearOp> {
  const eventsBefore = isoField(raw.eventsBefore);
  if (eventsBefore === null) return invalidPayload();
  return parsed({
    opId: raw.opId,
    kind: "history.clear",
    at: raw.at,
    tracks: undefined,
    trackVideoIds: [],
    eventsBefore,
  });
}

async function applyHistoryClear(oc: OpCtx, op: HistoryClearOp): Promise<OpOutcome> {
  const current = (await readPlayForgets(oc.q, oc.userId, [ALL_VIDEOS])).get(ALL_VIDEOS) ?? null;
  const mark = raiseClearMark(current?.eventsBefore ?? null, Math.min(op.eventsBefore, oc.now));
  if (mark === null) return applied();
  await writePlayForget(
    oc.q,
    oc.userId,
    ALL_VIDEOS,
    { eventsBefore: mark, totalBefore: current?.totalBefore ?? null },
    oc.next(),
  );
  await deleteHistoryEvents(oc, mark);
  return applied();
}

function touchHistoryClear(_raw: WireOp, touched: TouchedKeys): void {
  touched.playForgets.add(ALL_VIDEOS);
}

export const historyClearHandler: OpHandler<HistoryClearOp> = Object.freeze({
  kind: "history.clear",
  implemented: true,
  journaled: true,
  parse: parseHistoryClear,
  apply: applyHistoryClear,
  touch: touchHistoryClear,
});
