/**
 * `play.baseline` (DESIGN §3.7, §3.14; API §4.8): the total listening time of up to 500 tracks, sent when a device
 * joins or merges (`add` after «Объединить», `atLeast` after a silent merge) and when the outbox folds plays into
 * one op (DESIGN §3.13.2).
 *
 * ```
 * effAt = min(at, now)
 * per entry: forgets[videoId].total_before ≥ effAt  → skipped (the total was reset after the baseline was taken)
 *            add:     total_ms += totalMs
 *            atLeast: total_ms  = max(total_ms, totalMs)
 *            the row changed → new seq; no row → a new row within the play_stats quota
 * every entry skipped → superseded, otherwise applied
 * ```
 */
import { SYNC_LIMITS } from "../../../contract/limits.ts";
import { BASELINE_MODE_VALUES } from "../../../contract/sync.ts";
import type { BaselineMode } from "../../../contract/sync.ts";
import {
  HISTORY_COUNTERS,
  invalidPayload,
  invalidVideoId,
  isBadVideoId,
  isRecord,
  isVideoId,
  newPlayStatsAllowed,
  rawTracks,
  readPlayForgets,
  readPlayStats,
  writePlayStats,
} from "./play-add.ts";
import type { PlayStat } from "./play-add.ts";
import { applied, parsed, superseded } from "./types.ts";
import type { OpCtx, OpEnv, OpHandler, OpOutcome, OpParseResult, ParsedOp, TouchedKeys, WireOp } from "./types.ts";

export type BaselineEntryOp = Readonly<{ videoId: string; totalMs: number }>;

export type PlayBaselineOp = ParsedOp & Readonly<{ mode: BaselineMode; entries: readonly BaselineEntryOp[] }>;

/** DESIGN §3.7: the entry is skipped when the track's total was reset at or after `effAt`. */
export function baselineSkips(totalBefore: number | null, effAt: number): boolean {
  return totalBefore !== null && totalBefore >= effAt;
}

/** The total after one baseline entry; sums stop at 2^53 − 1 (API §1.4). */
export function baselineTotal(mode: BaselineMode, currentMs: number, totalMs: number): number {
  return mode === "add" ? Math.min(currentMs + totalMs, Number.MAX_SAFE_INTEGER) : Math.max(currentMs, totalMs);
}

function isBaselineMode(value: unknown): value is BaselineMode {
  return BASELINE_MODE_VALUES.some((mode) => mode === value);
}

/** API §4.8: `mode` (`add|atLeast`), `entries` (1..500 `{videoId, totalMs 1..2^53−1}` with unique videoIds). */
function parsePlayBaseline(raw: WireOp): OpParseResult<PlayBaselineOp> {
  const { mode, entries } = raw;
  if (Array.isArray(entries) && entries.some((entry) => isRecord(entry) && isBadVideoId(entry.videoId))) {
    return invalidVideoId();
  }
  if (
    !isBaselineMode(mode) ||
    !Array.isArray(entries) ||
    entries.length < 1 ||
    entries.length > SYNC_LIMITS.maxBaselineEntries
  ) {
    return invalidPayload();
  }
  const seen = new Set<string>();
  const parsedEntries: BaselineEntryOp[] = [];
  for (const entry of entries as unknown[]) {
    if (!isRecord(entry)) return invalidPayload();
    const { videoId, totalMs } = entry;
    if (!isVideoId(videoId) || seen.has(videoId)) return invalidPayload();
    if (typeof totalMs !== "number" || !Number.isSafeInteger(totalMs) || totalMs < 1) return invalidPayload();
    seen.add(videoId);
    parsedEntries.push({ videoId, totalMs });
  }
  return parsed({
    opId: raw.opId,
    kind: "play.baseline",
    at: raw.at,
    tracks: rawTracks(raw),
    trackVideoIds: [...seen],
    mode,
    entries: parsedEntries,
  });
}

async function applyPlayBaseline(oc: OpCtx, op: PlayBaselineOp, env: OpEnv): Promise<OpOutcome> {
  const videoIds = op.entries.map((entry) => entry.videoId);
  const forgets = await readPlayForgets(oc.q, oc.userId, videoIds);
  const stats = await readPlayStats(oc.q, oc.userId, videoIds);

  type Planned = Readonly<{ videoId: string; row: PlayStat; created: boolean }>;
  const planned: Planned[] = [];
  let skipped = 0;
  for (const entry of op.entries) {
    if (baselineSkips(forgets.get(entry.videoId)?.totalBefore ?? null, env.effAt)) {
      skipped += 1;
      continue;
    }
    const current = stats.get(entry.videoId);
    const totalMs = baselineTotal(op.mode, current?.totalMs ?? 0, entry.totalMs);
    if (current === undefined) {
      planned.push({ videoId: entry.videoId, row: { totalMs, lastPlayedAt: null }, created: true });
    } else if (totalMs !== current.totalMs) {
      planned.push({ videoId: entry.videoId, row: { totalMs, lastPlayedAt: current.lastPlayedAt }, created: false });
    }
  }
  if (skipped === op.entries.length) return superseded();

  // New rows beyond the play_stats quota are not created (DESIGN §3.10); the first ones in entry order are.
  let creatable = await newPlayStatsAllowed(oc, planned.filter((entry) => entry.created).length);
  oc.counters.add(HISTORY_COUNTERS.stats, creatable);
  const rows: (PlayStat & Readonly<{ videoId: string; seq: number }>)[] = [];
  for (const entry of planned) {
    if (entry.created) {
      if (creatable === 0) continue;
      creatable -= 1;
    }
    rows.push({ videoId: entry.videoId, ...entry.row, seq: oc.next() });
  }
  await writePlayStats(oc.q, oc.userId, rows);
  return applied();
}

function touchPlayBaseline(raw: WireOp, touched: TouchedKeys): void {
  if (!Array.isArray(raw.entries)) return;
  for (const entry of raw.entries as unknown[]) {
    if (isRecord(entry) && isVideoId(entry.videoId)) touched.playStats.add(entry.videoId);
  }
}

export const playBaselineHandler: OpHandler<PlayBaselineOp> = Object.freeze({
  kind: "play.baseline",
  implemented: true,
  journaled: true,
  parse: parsePlayBaseline,
  apply: applyPlayBaseline,
  touch: touchPlayBaseline,
});
