/**
 * The history part of the daily `retention` job (API §5: `RETENTION_RUN_AT_UTC` ± 10 min, batches of 5000;
 * DESIGN §3.11.6, §3.5), in this order:
 *
 * 1. `play_events` with `in_history = 0` received more than 30 days ago: they only kept `play.add` idempotent
 *    (DESIGN §3.11.2); global batches over the partial index `play_events_idem`;
 * 2. `sync_ops` older than `SYNC_OPS_RETENTION_DAYS` (180): global batches over `sync_ops_server_at`;
 * 3. per user (keyset over `sync_heads`): in-history events played at or before `now − HISTORY_RETENTION_DAYS`
 *    (400 days), then the oldest in-history events above `HISTORY_MAX_EVENTS` (50 000; `play.add` keeps the cap on
 *    insert, this catches a lowered setting).
 *
 * Every batch is its own short `db.write` of at most 5000 rows (docs/database.md §4.4), so the SQLite writer is free
 * between batches. Retention is not a deletion for clients (DESIGN §3.8, §3.11.6): it takes no `lockUser`, spends no
 * `seq`, leaves `sync_heads` alone and publishes nothing (API §5). `play_stats` and `play_forgets` live as long as
 * the account. Playback retention is `src/modules/playback` (PLAN T2.4); `src/jobs/index.ts` (PLAN T3.1) registers
 * the `retention` job that runs both.
 */
import type { Env } from "../../../config/env.ts";
import { DELETE_BATCH_ROWS, IN_BATCH_VALUES, deleteInBatches } from "../../../db/batch.ts";
import type { Db, Queryable } from "../../../db/index.ts";
import type { JobRunContext } from "../../../jobs/scheduler.ts";
import { DAY_MS } from "../../../lib/clock.ts";

/** DESIGN §3.11.6: `in_history = 0` rows are kept 30 days (by `received_at`). */
export const IDEMPOTENCY_RETENTION_DAYS = 30;

export type HistoryRetentionContext = Readonly<{
  db: Pick<Db, "read" | "write">;
  env: Pick<Env, "HISTORY_RETENTION_DAYS" | "HISTORY_MAX_EVENTS" | "SYNC_OPS_RETENTION_DAYS">;
}>;

export type HistoryRetentionOptions = Readonly<{
  /** Epoch ms the cutoffs are computed from (the job's `startedAt`). */
  now: number;
  /** Stops the run between batches (server shutdown). */
  signal?: AbortSignal;
  /** Rows per batch (default 5000). */
  batchSize?: number;
  /** Users per page of the per-user step (default 1000). */
  userPageSize?: number;
  /** Lets other work take the writer between batches (default `setImmediate`). */
  yieldBetween?: () => Promise<void>;
}>;

export type HistoryRetentionResult = Readonly<{
  /** `in_history = 0` rows past the 30 days. */
  idempotencyEvents: number;
  /** `sync_ops` rows past `SYNC_OPS_RETENTION_DAYS`. */
  syncOps: number;
  /** In-history events past `HISTORY_RETENTION_DAYS`. */
  expiredEvents: number;
  /** In-history events above `HISTORY_MAX_EVENTS`. */
  excessEvents: number;
  /** Whether the signal stopped the run before the end. */
  stopped: boolean;
}>;

type Cutoffs = Readonly<{ idempotency: number; syncOps: number; history: number }>;

function cutoffs(env: HistoryRetentionContext["env"], now: number): Cutoffs {
  return {
    idempotency: now - IDEMPOTENCY_RETENTION_DAYS * DAY_MS,
    syncOps: now - env.SYNC_OPS_RETENTION_DAYS * DAY_MS,
    history: now - env.HISTORY_RETENTION_DAYS * DAY_MS,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Statements (each deletes at most `limit` rows)
// ---------------------------------------------------------------------------------------------------------------------

async function deleteIdempotencyRows(q: Queryable, cutoff: number, limit: number): Promise<number> {
  const result = await q
    .deleteFrom("play_events")
    .where((eb) =>
      eb(
        eb.refTuple("user_id", "event_id"),
        "in",
        eb
          .selectFrom("play_events")
          .select(["user_id", "event_id"])
          .where("in_history", "=", 0)
          .where("received_at", "<=", cutoff)
          .limit(limit)
          .$asTuple("user_id", "event_id"),
      ),
    )
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}

async function deleteOldSyncOps(q: Queryable, cutoff: number, limit: number): Promise<number> {
  const result = await q
    .deleteFrom("sync_ops")
    .where((eb) =>
      eb(
        eb.refTuple("user_id", "seq"),
        "in",
        eb
          .selectFrom("sync_ops")
          .select(["user_id", "seq"])
          .where("server_at", "<=", cutoff)
          .limit(limit)
          .$asTuple("user_id", "seq"),
      ),
    )
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}

async function deleteExpiredHistory(q: Queryable, userId: string, cutoff: number, limit: number): Promise<number> {
  const result = await q
    .deleteFrom("play_events")
    .where("user_id", "=", userId)
    .where(
      "event_id",
      "in",
      q
        .selectFrom("play_events")
        .select("event_id")
        .where("user_id", "=", userId)
        .where("in_history", "=", 1)
        .where("played_at", "<=", cutoff)
        .limit(limit),
    )
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}

/** Deletes up to `limit` of the oldest in-history events above `maxEvents` (counted in the same transaction). */
async function deleteExcessHistory(q: Queryable, userId: string, maxEvents: number, limit: number): Promise<number> {
  const row = await q
    .selectFrom("play_events")
    .select((eb) => eb.fn.countAll().as("n"))
    .where("user_id", "=", userId)
    .where("seq", "is not", null)
    .executeTakeFirst();
  const excess = Number(row?.n ?? 0) - maxEvents;
  if (excess <= 0) return 0;
  const result = await q
    .deleteFrom("play_events")
    .where("user_id", "=", userId)
    .where(
      "event_id",
      "in",
      q
        .selectFrom("play_events")
        .select("event_id")
        .where("user_id", "=", userId)
        .where("in_history", "=", 1)
        .orderBy("played_at")
        .orderBy("event_id")
        .limit(Math.min(excess, limit)),
    )
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}

type UserPage = Readonly<{ users: readonly string[]; expired: readonly string[]; excess: readonly string[] }>;

/**
 * The next page of users (keyset over `sync_heads.user_id`, an `ID` column: byte order in both dialects) and the ones
 * among them that have in-history events to delete.
 */
async function readUserPage(
  q: Queryable,
  after: string | null,
  size: number,
  cutoff: number,
  maxEvents: number,
): Promise<UserPage> {
  let heads = q.selectFrom("sync_heads").select("user_id");
  if (after !== null) heads = heads.where("user_id", ">", after);
  const users = (await heads.orderBy("user_id").limit(size).execute()).map((row) => row.user_id);
  if (users.length === 0) return { users, expired: [], excess: [] };
  const expired = await q
    .selectFrom("play_events")
    .select("user_id")
    .distinct()
    .where("user_id", "in", users)
    .where("in_history", "=", 1)
    .where("played_at", "<=", cutoff)
    .execute();
  const excess = await q
    .selectFrom("play_events")
    .select("user_id")
    .where("user_id", "in", users)
    .where("seq", "is not", null)
    .groupBy("user_id")
    .having((eb) => eb.fn.countAll(), ">", maxEvents)
    .execute();
  return { users, expired: expired.map((row) => row.user_id), excess: excess.map((row) => row.user_id) };
}

// ---------------------------------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------------------------------

/** Runs the history retention once (see the module comment). */
export async function runHistoryRetention(
  ctx: HistoryRetentionContext,
  options: HistoryRetentionOptions,
): Promise<HistoryRetentionResult> {
  const { db, env } = ctx;
  const cut = cutoffs(env, options.now);
  const signal = options.signal;
  const batchSize = options.batchSize ?? DELETE_BATCH_ROWS;
  const userPageSize = Math.min(options.userPageSize ?? IN_BATCH_VALUES, IN_BATCH_VALUES);
  const loop = {
    batchSize,
    ...(options.yieldBetween ? { yieldBetween: options.yieldBetween } : {}),
  };
  const aborted = () => signal?.aborted === true;
  /** Batches until one deletes fewer than `limit` rows or the signal fires. */
  const inBatches = (deleteBatch: (q: Queryable, limit: number) => Promise<number>) =>
    deleteInBatches((limit) => (aborted() ? Promise.resolve(0) : db.write((q) => deleteBatch(q, limit))), loop);

  const idempotencyEvents = await inBatches((q, limit) => deleteIdempotencyRows(q, cut.idempotency, limit));
  const syncOps = await inBatches((q, limit) => deleteOldSyncOps(q, cut.syncOps, limit));

  let expiredEvents = 0;
  let excessEvents = 0;
  let after: string | null = null;
  while (!aborted()) {
    const page: UserPage = await db.read((q) =>
      readUserPage(q, after, userPageSize, cut.history, env.HISTORY_MAX_EVENTS),
    );
    for (const userId of page.expired) {
      expiredEvents += await inBatches((q, limit) => deleteExpiredHistory(q, userId, cut.history, limit));
    }
    for (const userId of page.excess) {
      excessEvents += await inBatches((q, limit) => deleteExcessHistory(q, userId, env.HISTORY_MAX_EVENTS, limit));
    }
    if (page.users.length < userPageSize) break;
    after = page.users[page.users.length - 1] ?? null;
  }

  return { idempotencyEvents, syncOps, expiredEvents, excessEvents, stopped: aborted() };
}

/**
 * The history step of the `retention` job for `src/jobs/index.ts`: runs {@link runHistoryRetention} at the job's
 * start time, stops with the scheduler and logs what it deleted.
 */
export async function historyRetentionJob(
  ctx: HistoryRetentionContext,
  job: Pick<JobRunContext, "name" | "signal" | "startedAt" | "log">,
): Promise<HistoryRetentionResult> {
  const result = await runHistoryRetention(ctx, { now: job.startedAt, signal: job.signal });
  job.log.info({ job: job.name, ...result }, "history retention finished");
  return result;
}
