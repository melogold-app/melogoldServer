/**
 * `play.add` (DESIGN §3.7, §3.11.3; API §4.8): one listening session of at least 5 s, sent by the device that played
 * it. The op id is the event id (the `play_events` key), so the runner recognizes a repeated op through
 * `play_events` and the op is not journaled in `sync_ops`.
 *
 * ```
 * eff = min(playedAt, now)
 * play.add accepted in the last hour ≥ 2000                 → deferred op_rate_limited{retryAfterSeconds}
 * inHistory = history ∧ eff > max(forgets['*'], forgets[videoId]).events_before ∧ eff > now − HISTORY_RETENTION_DAYS
 * make room (DESIGN §3.10): in-history rows ≥ HISTORY_MAX_EVENTS → the oldest in-history rows go;
 *                           all rows ≥ 60 000 → the oldest in_history=0 rows go, then the oldest in-history rows
 * INSERT play_events (event_id = opId, played_at = eff, seq only when inHistory, received_at = now)
 * play_stats[videoId]: + playTimeMs when playtime ∧ eff > forgets[videoId].total_before;
 *                      last_played_at = max(…, eff) when inHistory;
 *                      one new seq when the row changed; a new row only within the play_stats quota (100 000)
 * ```
 *
 * An event that arrives after a history clear still counts in the total, as in ViTune (DESIGN §3.11.3).
 *
 * The file also holds what the four history ops share (`play-baseline.ts`, `history-clear.ts`, `history-forget.ts`):
 * field parsing, reads and writes of `play_stats` and `play_forgets`, the request counters of the history quotas and
 * the batched deletion of history events. Everything runs inside the `/sync` write transaction that holds
 * `lockUser`, so "read, compute in TS, write" is safe here (docs/database.md §2.5).
 */
import { VIDEO_ID_PATTERN } from "../../../contract/common.ts";
import { SYNC_LIMITS } from "../../../contract/limits.ts";
import { ALL_VIDEOS, PLAY_TIME_MS_MAX } from "../../../contract/sync.ts";
import { DELETE_BATCH_ROWS, insertInChunks, selectInChunks } from "../../../db/batch.ts";
import type { Queryable } from "../../../db/index.ts";
import { DAY_MS, HOUR_MS, SECOND_MS } from "../../../lib/clock.ts";
import { parseIso } from "../../../lib/time.ts";
import { applied, deferred, notParsed, opRateLimited, parsed, rejected } from "./types.ts";
import type { OpCtx, OpHandler, OpOutcome, OpParseResult, ParsedOp, TouchedKeys, WireOp } from "./types.ts";

// ---------------------------------------------------------------------------------------------------------------------
// Field parsing shared by the history ops (DESIGN §3.9)
// ---------------------------------------------------------------------------------------------------------------------

export function isVideoId(value: unknown): value is string {
  return typeof value === "string" && VIDEO_ID_PATTERN.test(value);
}

/** A string that is not a videoId: the op can never apply (`rejected invalid_video_id`, DESIGN §3.9). */
export function isBadVideoId(value: unknown): boolean {
  return typeof value === "string" && !VIDEO_ID_PATTERN.test(value);
}

/** An `Iso` field of an op (API §1.5) in epoch milliseconds; `null` when absent or not an accepted timestamp. */
export function isoField(value: unknown): number | null {
  return typeof value === "string" ? parseIso(value) : null;
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function invalidVideoId<P extends ParsedOp>(): OpParseResult<P> {
  return notParsed(rejected("invalid_video_id"));
}

export function invalidPayload<P extends ParsedOp>(): OpParseResult<P> {
  return notParsed(deferred("invalid_payload"));
}

/** `ParsedOp.tracks`: the raw field, `undefined` when absent or `null`. */
export function rawTracks(raw: WireOp): unknown {
  return raw.tracks ?? undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// play_stats and play_forgets
// ---------------------------------------------------------------------------------------------------------------------

/** A `play_stats` row without its keys and `seq` (API §4.8 `PlayStatRow`). */
export type PlayStat = Readonly<{ totalMs: number; lastPlayedAt: number | null }>;

/** A `play_forgets` row without its keys and `seq` (API §4.8 `PlayForgetRow`): both marks are inclusive. */
export type PlayForget = Readonly<{ eventsBefore: number; totalBefore: number | null }>;

/** `play_stats` rows of the user for these videoIds. */
export async function readPlayStats(
  q: Queryable,
  userId: string,
  videoIds: readonly string[],
): Promise<Map<string, PlayStat>> {
  const rows = await selectInChunks(videoIds, (chunk) =>
    q
      .selectFrom("play_stats")
      .select(["video_id", "total_ms", "last_played_at"])
      .where("user_id", "=", userId)
      .where("video_id", "in", chunk)
      .execute(),
  );
  return new Map(rows.map((row) => [row.video_id, { totalMs: row.total_ms, lastPlayedAt: row.last_played_at }]));
}

/** Writes whole `play_stats` rows (computed in TS under `lockUser`), each with its new `seq`. */
export async function writePlayStats(
  q: Queryable,
  userId: string,
  rows: readonly (PlayStat & Readonly<{ videoId: string; seq: number }>)[],
): Promise<void> {
  await insertInChunks(rows, (chunk) =>
    q
      .insertInto("play_stats")
      .values(
        chunk.map((row) => ({
          user_id: userId,
          video_id: row.videoId,
          total_ms: row.totalMs,
          last_played_at: row.lastPlayedAt,
          seq: row.seq,
        })),
      )
      .onConflict((conflict) =>
        conflict.columns(["user_id", "video_id"]).doUpdateSet((eb) => ({
          total_ms: eb.ref("excluded.total_ms"),
          last_played_at: eb.ref("excluded.last_played_at"),
          seq: eb.ref("excluded.seq"),
        })),
      )
      .execute(),
  );
}

/** `play_forgets` rows of the user for these keys (videoIds and/or {@link ALL_VIDEOS}). */
export async function readPlayForgets(
  q: Queryable,
  userId: string,
  videoIds: readonly string[],
): Promise<Map<string, PlayForget>> {
  const rows = await selectInChunks(videoIds, (chunk) =>
    q
      .selectFrom("play_forgets")
      .select(["video_id", "events_before", "total_before"])
      .where("user_id", "=", userId)
      .where("video_id", "in", chunk)
      .execute(),
  );
  return new Map(rows.map((row) => [row.video_id, { eventsBefore: row.events_before, totalBefore: row.total_before }]));
}

/** Writes a whole `play_forgets` row with its new `seq` (the marks only grow: the caller computed them). */
export async function writePlayForget(
  q: Queryable,
  userId: string,
  videoId: string,
  forget: PlayForget,
  seq: number,
): Promise<void> {
  await q
    .insertInto("play_forgets")
    .values({
      user_id: userId,
      video_id: videoId,
      events_before: forget.eventsBefore,
      total_before: forget.totalBefore,
      seq,
    })
    .onConflict((conflict) =>
      conflict.columns(["user_id", "video_id"]).doUpdateSet((eb) => ({
        events_before: eb.ref("excluded.events_before"),
        total_before: eb.ref("excluded.total_before"),
        seq: eb.ref("excluded.seq"),
      })),
    )
    .execute();
}

// ---------------------------------------------------------------------------------------------------------------------
// Quotas of one request (DESIGN §3.10: COUNT(*) once, then in memory)
// ---------------------------------------------------------------------------------------------------------------------

/** Keys of the history counters in `oc.counters`. */
export const HISTORY_COUNTERS = Object.freeze({
  /** All `play_events` rows of the user. */
  events: "history.play_events",
  /** `play_events` rows with `in_history = 1` (exactly the rows with a `seq`). */
  inHistory: "history.play_events.in_history",
  /** `play.add` accepted in the last hour (rows with `received_at > now − 1 h`). */
  lastHour: "history.play_add.last_hour",
  /** `received_at` of the 2000th newest row of the last hour (0: none), for `retryAfterSeconds`. */
  rateBoundary: "history.play_add.rate_boundary",
  /** `play_stats` rows of the user. */
  stats: "history.play_stats",
});

async function countRows(query: Promise<{ n: number | string | bigint } | undefined>): Promise<number> {
  const row = await query;
  return Number(row?.n ?? 0);
}

function countEvents(q: Queryable, userId: string): Promise<number> {
  return countRows(
    q
      .selectFrom("play_events")
      .select((eb) => eb.fn.countAll().as("n"))
      .where("user_id", "=", userId)
      .executeTakeFirst(),
  );
}

function countHistoryEvents(q: Queryable, userId: string): Promise<number> {
  // `seq IS NOT NULL` ⇔ `in_history = 1` (API §9.2); it matches the partial index `play_events_pull`.
  return countRows(
    q
      .selectFrom("play_events")
      .select((eb) => eb.fn.countAll().as("n"))
      .where("user_id", "=", userId)
      .where("seq", "is not", null)
      .executeTakeFirst(),
  );
}

function countPlayStats(q: Queryable, userId: string): Promise<number> {
  return countRows(
    q
      .selectFrom("play_stats")
      .select((eb) => eb.fn.countAll().as("n"))
      .where("user_id", "=", userId)
      .executeTakeFirst(),
  );
}

/**
 * How many of `wanted` new `play_stats` rows fit the quota (DESIGN §3.10: 100 000; beyond it no counter is created
 * for a new track, the op still applies). The caller creates that many and reports them with
 * `oc.counters.add(HISTORY_COUNTERS.stats, n)`.
 */
export async function newPlayStatsAllowed(oc: OpCtx, wanted: number): Promise<number> {
  if (wanted <= 0) return 0;
  const count = await oc.counters.get(HISTORY_COUNTERS.stats, () => countPlayStats(oc.q, oc.userId));
  return Math.max(0, Math.min(wanted, SYNC_LIMITS.maxPlayStats - count));
}

/**
 * Rows evicted at once when a cap of `play_events` is reached: 1% of the cap, at most one full request of ops, so
 * a request that arrives at the cap scans for victims once instead of once per op.
 */
export function evictionBatch(cap: number): number {
  return Math.min(SYNC_LIMITS.maxOpsPerRequest, Math.floor(cap / 100));
}

// ---------------------------------------------------------------------------------------------------------------------
// Deleting events
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Deletes the in-history events of the user played at or before `before` (of one video when given), in statements
 * of at most {@link DELETE_BATCH_ROWS} rows (DESIGN §3.7), and keeps the history counters of the request in step.
 * `in_history = 0` rows stay: they are not history, they keep `play.add` idempotent (DESIGN §3.11.2).
 * @returns the number of deleted events.
 */
export async function deleteHistoryEvents(oc: OpCtx, before: number, videoId?: string): Promise<number> {
  let total = 0;
  for (;;) {
    let victims = oc.q
      .selectFrom("play_events")
      .select("event_id")
      .where("user_id", "=", oc.userId)
      .where("in_history", "=", 1)
      .where("played_at", "<=", before);
    if (videoId !== undefined) victims = victims.where("video_id", "=", videoId);
    const result = await oc.q
      .deleteFrom("play_events")
      .where("user_id", "=", oc.userId)
      .where("event_id", "in", victims.limit(DELETE_BATCH_ROWS))
      .executeTakeFirst();
    const deleted = Number(result.numDeletedRows);
    total += deleted;
    if (deleted < DELETE_BATCH_ROWS) break;
  }
  oc.counters.add(HISTORY_COUNTERS.events, -total);
  oc.counters.add(HISTORY_COUNTERS.inHistory, -total);
  return total;
}

/** Deletes up to `limit` oldest (`played_at`, then `event_id`) events of the user with this `in_history`. */
async function evictOldest(oc: OpCtx, inHistory: 0 | 1, limit: number): Promise<number> {
  if (limit <= 0) return 0;
  const victims = oc.q
    .selectFrom("play_events")
    .select("event_id")
    .where("user_id", "=", oc.userId)
    .where("in_history", "=", inHistory)
    .orderBy("played_at")
    .orderBy("event_id")
    .limit(limit);
  const result = await oc.q
    .deleteFrom("play_events")
    .where("user_id", "=", oc.userId)
    .where("event_id", "in", victims)
    .executeTakeFirst();
  const deleted = Number(result.numDeletedRows);
  oc.counters.add(HISTORY_COUNTERS.events, -deleted);
  if (inHistory === 1) oc.counters.add(HISTORY_COUNTERS.inHistory, -deleted);
  return deleted;
}

/**
 * Makes room for one more event (DESIGN §3.10, §3.11.6): at most `HISTORY_MAX_EVENTS` in-history events and
 * 60 000 events in all. The oldest in_history=0 rows go first, then the oldest in-history rows.
 */
async function makeRoomForEvent(oc: OpCtx, inHistory: boolean): Promise<void> {
  if (inHistory) {
    const cap = oc.env.HISTORY_MAX_EVENTS;
    const count = await oc.counters.get(HISTORY_COUNTERS.inHistory, () => countHistoryEvents(oc.q, oc.userId));
    if (count >= cap) await evictOldest(oc, 1, count - cap + 1 + evictionBatch(cap));
  }
  const cap = SYNC_LIMITS.maxPlayEvents;
  const total = await oc.counters.get(HISTORY_COUNTERS.events, () => countEvents(oc.q, oc.userId));
  if (total < cap) return;
  const need = total - cap + 1 + evictionBatch(cap);
  const idle = await evictOldest(oc, 0, need);
  if (idle < need) await evictOldest(oc, 1, need - idle);
}

// ---------------------------------------------------------------------------------------------------------------------
// Rate limit (DESIGN §3.10: 2000 play.add per hour and user)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * `retryAfterSeconds` when the user already had 2000 `play.add` in the last hour, else `null`. The client keeps the
 * op pending and retries after that many seconds (API §2.3): the 2000th newest event of the hour has left the window
 * by then.
 */
async function playAddRetryAfter(oc: OpCtx): Promise<number | null> {
  const limit = SYNC_LIMITS.playAddPerHour;
  const since = oc.now - HOUR_MS;
  const recent = await oc.counters.get(HISTORY_COUNTERS.lastHour, () =>
    countRows(
      oc.q
        .selectFrom("play_events")
        .select((eb) => eb.fn.countAll().as("n"))
        .where("user_id", "=", oc.userId)
        .where("received_at", ">", since)
        .executeTakeFirst(),
    ),
  );
  if (recent < limit) return null;
  const boundary = await oc.counters.get(HISTORY_COUNTERS.rateBoundary, async () => {
    const row = await oc.q
      .selectFrom("play_events")
      .select("received_at")
      .where("user_id", "=", oc.userId)
      .where("received_at", ">", since)
      .orderBy("received_at", "desc")
      .limit(1)
      .offset(limit - 1)
      .executeTakeFirst();
    return row?.received_at ?? 0;
  });
  return Math.max(1, Math.ceil((boundary + HOUR_MS - oc.now) / SECOND_MS));
}

// ---------------------------------------------------------------------------------------------------------------------
// Pure rules (spec/history-totals.vectors.json)
// ---------------------------------------------------------------------------------------------------------------------

export type PlayAddInput = Readonly<{
  /** `min(playedAt, now)`. */
  eff: number;
  now: number;
  history: boolean;
  playtime: boolean;
  /** `max(forgets['*'].events_before, forgets[videoId].events_before)`; `null` when neither exists. */
  eventsBefore: number | null;
  /** `forgets[videoId].total_before`. */
  totalBefore: number | null;
  retentionDays: number;
}>;

/** DESIGN §3.11.3: whether the event enters the history stream and whether its time counts in the total. */
export function planPlayAdd(input: PlayAddInput): Readonly<{ inHistory: boolean; countsTotal: boolean }> {
  const inHistory =
    input.history &&
    (input.eventsBefore === null || input.eff > input.eventsBefore) &&
    input.eff > input.now - input.retentionDays * DAY_MS;
  const countsTotal = input.playtime && (input.totalBefore === null || input.eff > input.totalBefore);
  return { inHistory, countsTotal };
}

/**
 * The `play_stats` row after one play: `addMs` added (0 when it does not count), `last_played_at` raised to
 * `playedAt` (`null` when the event is not in the history). Totals stop at 2^53 − 1 (API §1.4).
 */
export function nextPlayStat(current: PlayStat | null, addMs: number, playedAt: number | null): PlayStat {
  const totalMs = Math.min((current?.totalMs ?? 0) + addMs, Number.MAX_SAFE_INTEGER);
  const last = current?.lastPlayedAt ?? null;
  const lastPlayedAt = playedAt === null ? last : last === null ? playedAt : Math.max(last, playedAt);
  return { totalMs, lastPlayedAt };
}

/** The larger of two optional marks. */
export function laterMark(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a === null || a === undefined) return b ?? null;
  if (b === null || b === undefined) return a;
  return Math.max(a, b);
}

// ---------------------------------------------------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------------------------------------------------

export type PlayAddOp = ParsedOp &
  Readonly<{ videoId: string; playedAt: number; playTimeMs: number; history: boolean; playtime: boolean }>;

/**
 * API §4.8: `videoId`, `playedAt`, `playTimeMs` (1..86 400 000), `history`, `playtime` (at least one `true`).
 * `at` of the parsed op is `playedAt`: API §4.8 makes them equal, and DESIGN §3.11.3 resolves with `playedAt`.
 */
function parsePlayAdd(raw: WireOp): OpParseResult<PlayAddOp> {
  if (isBadVideoId(raw.videoId)) return invalidVideoId();
  const { videoId, playTimeMs, history, playtime } = raw;
  const playedAt = isoField(raw.playedAt);
  if (
    !isVideoId(videoId) ||
    playedAt === null ||
    typeof playTimeMs !== "number" ||
    !Number.isSafeInteger(playTimeMs) ||
    playTimeMs < 1 ||
    playTimeMs > PLAY_TIME_MS_MAX ||
    typeof history !== "boolean" ||
    typeof playtime !== "boolean" ||
    (!history && !playtime)
  ) {
    return invalidPayload();
  }
  return parsed({
    opId: raw.opId,
    kind: "play.add",
    at: playedAt,
    tracks: rawTracks(raw),
    trackVideoIds: [videoId],
    videoId,
    playedAt,
    playTimeMs,
    history,
    playtime,
  });
}

/** Applies one play to `play_stats`; returns the new `seq`, or `null` when the row did not change. */
async function addPlayToStats(
  oc: OpCtx,
  videoId: string,
  addMs: number,
  playedAt: number | null,
): Promise<number | null> {
  if (addMs === 0 && playedAt === null) return null;
  const current = (await readPlayStats(oc.q, oc.userId, [videoId])).get(videoId) ?? null;
  const next = nextPlayStat(current, addMs, playedAt);
  if (current !== null && current.totalMs === next.totalMs && current.lastPlayedAt === next.lastPlayedAt) return null;
  if (current === null) {
    if ((await newPlayStatsAllowed(oc, 1)) === 0) return null;
    oc.counters.add(HISTORY_COUNTERS.stats, 1);
  }
  const seq = oc.next();
  await writePlayStats(oc.q, oc.userId, [{ videoId, ...next, seq }]);
  return seq;
}

async function applyPlayAdd(oc: OpCtx, op: PlayAddOp): Promise<OpOutcome> {
  const retryAfter = await playAddRetryAfter(oc);
  if (retryAfter !== null) return opRateLimited(retryAfter);

  const eff = Math.min(op.playedAt, oc.now);
  const forgets = await readPlayForgets(oc.q, oc.userId, [ALL_VIDEOS, op.videoId]);
  const own = forgets.get(op.videoId);
  const plan = planPlayAdd({
    eff,
    now: oc.now,
    history: op.history,
    playtime: op.playtime,
    eventsBefore: laterMark(forgets.get(ALL_VIDEOS)?.eventsBefore, own?.eventsBefore),
    totalBefore: own?.totalBefore ?? null,
    retentionDays: oc.env.HISTORY_RETENTION_DAYS,
  });

  await makeRoomForEvent(oc, plan.inHistory);
  const eventSeq = plan.inHistory ? oc.next() : null;
  const inserted = await oc.q
    .insertInto("play_events")
    .values({
      user_id: oc.userId,
      event_id: op.opId,
      video_id: op.videoId,
      played_at: eff,
      play_time_ms: op.playTimeMs,
      in_history: plan.inHistory ? 1 : 0,
      counts_playtime: op.playtime ? 1 : 0,
      device_id: oc.deviceId,
      seq: eventSeq,
      received_at: oc.now,
    })
    .onConflict((conflict) => conflict.columns(["user_id", "event_id"]).doNothing())
    .returning("event_id")
    .executeTakeFirst();
  // The runner answers a known eventId as a replay before `apply` (DESIGN §3.8); this only guards the counters.
  if (inserted === undefined) return applied();
  oc.counters.add(HISTORY_COUNTERS.events, 1);
  oc.counters.add(HISTORY_COUNTERS.lastHour, 1);
  if (plan.inHistory) oc.counters.add(HISTORY_COUNTERS.inHistory, 1);

  const statSeq = await addPlayToStats(
    oc,
    op.videoId,
    plan.countsTotal ? op.playTimeMs : 0,
    plan.inHistory ? eff : null,
  );
  const seq = Math.max(eventSeq ?? 0, statSeq ?? 0);
  return seq > 0 ? applied({ seq }) : applied();
}

function touchPlayAdd(raw: WireOp, touched: TouchedKeys): void {
  if (isVideoId(raw.videoId)) touched.playStats.add(raw.videoId);
}

export const playAddHandler: OpHandler<PlayAddOp> = Object.freeze({
  kind: "play.add",
  implemented: true,
  journaled: false,
  parse: parsePlayAdd,
  apply: applyPlayAdd,
  touch: touchPlayAdd,
});
