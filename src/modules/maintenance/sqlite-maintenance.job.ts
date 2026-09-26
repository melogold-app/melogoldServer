/**
 * `sqlite-maintenance` (API §5: SQLite only, every 6 h and daily; API §9.4):
 *
 * - every run: `PRAGMA optimize` (the planner statistics; the connection also runs it on open);
 * - once a day (the first run at least {@link HEAVY_EVERY_MS} after the previous heavy one or the process start, in
 *   practice the daily run after `retention`): `PRAGMA incremental_vacuum` (the database is
 *   `auto_vacuum = INCREMENTAL`, API §9.1: retention and the account purge free pages, this gives them back to the
 *   file system), then `PRAGMA wal_checkpoint(TRUNCATE)`.
 *
 * `optimize` and the checkpoint are autocommit statements (`db.run`) outside any transaction; the vacuum gives pages
 * back in write transactions of {@link VACUUM_PAGES_PER_TX}. PostgreSQL needs none of it (autovacuum), so
 * `src/jobs/index.ts` registers the job only for SQLite.
 */
import type { AppContext } from "../../context.ts";
import type { JobDefinition, JobRunContext, UtcTime } from "../../jobs/scheduler.ts";
import { HOUR_MS, MINUTE_MS } from "../../lib/clock.ts";
import { checkpointSqlite, incrementalVacuumSqlite, optimizeSqlite } from "./maintenance.repository.ts";

/** Free pages given back per write transaction of the heavy run; the writer is free between them. */
export const VACUUM_PAGES_PER_TX = 1000;

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

export const SQLITE_MAINTENANCE_JOB = "sqlite-maintenance";
export const SQLITE_OPTIMIZE_EVERY_MS = 6 * HOUR_MS;
/** The daily run: half an hour after the default `RETENTION_RUN_AT_UTC` (04:30), ±10 min. */
export const SQLITE_DAILY_AT: UtcTime = Object.freeze({ hour: 5, minute: 0 });
export const SQLITE_DAILY_JITTER_MS = 10 * MINUTE_MS;
/** A heavy run (vacuum and checkpoint) happens at most this often. */
export const HEAVY_EVERY_MS = 20 * HOUR_MS;

export type SqliteMaintenanceReport = Readonly<{ heavy: boolean; freedPages: number; checkpointBusy: boolean }>;

/** One run: `optimize`, and with `heavy` also `incremental_vacuum` and a truncating checkpoint. */
export async function runSqliteMaintenance(
  ctx: Pick<AppContext, "db">,
  options: Readonly<{ heavy: boolean }>,
): Promise<SqliteMaintenanceReport> {
  await ctx.db.run((q) => optimizeSqlite(q));
  if (!options.heavy) return Object.freeze({ heavy: false, freedPages: 0, checkpointBusy: false });
  let freedPages = 0;
  for (;;) {
    const freed = await ctx.db.write((q) => incrementalVacuumSqlite(q, VACUUM_PAGES_PER_TX));
    freedPages += freed;
    if (freed < VACUUM_PAGES_PER_TX) break;
    await yieldToEventLoop();
  }
  const checkpointBusy = await ctx.db.run((q) => checkpointSqlite(q));
  return Object.freeze({ heavy: true, freedPages, checkpointBusy });
}

/** The scheduler entry of `sqlite-maintenance`; `startedAt` is the process start (the first heavy run waits). */
export function sqliteMaintenanceJob(ctx: Pick<AppContext, "db">, startedAt: number): JobDefinition {
  let lastHeavyAt = startedAt;
  return Object.freeze({
    name: SQLITE_MAINTENANCE_JOB,
    schedules: [{ every: SQLITE_OPTIMIZE_EVERY_MS }, { dailyAt: SQLITE_DAILY_AT, jitterMs: SQLITE_DAILY_JITTER_MS }],
    run: async (job: JobRunContext) => {
      const heavy = job.startedAt - lastHeavyAt >= HEAVY_EVERY_MS;
      const report = await runSqliteMaintenance(ctx, { heavy });
      if (!heavy) return;
      lastHeavyAt = job.startedAt;
      if (report.checkpointBusy)
        job.log.warn({ job: job.name }, "the WAL checkpoint could not finish: readers held it");
      else job.log.info({ job: job.name, freedPages: report.freedPages }, "sqlite vacuumed and checkpointed");
    },
  });
}
