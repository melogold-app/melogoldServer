/**
 * The background jobs of the server process (API §5), registered on the scheduler by `server.ts` before it starts:
 *
 * | job                  | when                                        | what                                             |
 * | -------------------- | ------------------------------------------- | ------------------------------------------------ |
 * | `retention`          | daily at `RETENTION_RUN_AT_UTC` ± 10 min    | history (DESIGN §3.11.6), then `playback_state`   |
 * | `auth-cleanup`       | hourly                                      | tokens, links, throttle, inactive devices (§4.12) |
 * | `account-purge`      | every 15 min                                | rows of deleted accounts (DESIGN §4.9)            |
 * | `sqlite-maintenance` | SQLite only: every 6 h and daily            | `optimize`; daily `incremental_vacuum`, checkpoint |
 * | `disk-guard`         | every minute                                | free space behind `503 storage_full` (§3.10)      |
 *
 * `melogold jobs run <name>` (the CLI) runs one of them once through {@link serverJobs}. Jobs publish no SSE event and
 * move no `seq` (API §5).
 */
import type { AppContext } from "../context.ts";
import { MINUTE_MS } from "../lib/clock.ts";
import { accountPurgeJob } from "../modules/account/purge.job.ts";
import { authCleanupJob } from "../modules/maintenance/auth-cleanup.job.ts";
import { sqliteMaintenanceJob } from "../modules/maintenance/sqlite-maintenance.job.ts";
import { RETENTION_JITTER_MS, runPlaybackRetention } from "../modules/playback/playback-retention.job.ts";
import { historyRetentionJob } from "../modules/sync/history/retention.job.ts";
import type { JobDefinition, Scheduler } from "./scheduler.ts";

export const RETENTION_JOB = "retention";
export const DISK_GUARD_JOB = "disk-guard";

/** `retention`: the history step, then the playback step (each stops between batches when the server stops). */
function retentionJob(ctx: AppContext): JobDefinition {
  return Object.freeze({
    name: RETENTION_JOB,
    schedules: [{ dailyAt: ctx.env.RETENTION_RUN_AT_UTC, jitterMs: RETENTION_JITTER_MS }],
    run: async (job) => {
      await historyRetentionJob(ctx, job);
      if (job.signal.aborted) return;
      const playbackStates = await runPlaybackRetention(ctx);
      if (playbackStates > 0) job.log.info({ job: job.name, playbackStates }, "playback retention finished");
    },
  });
}

function diskGuardJob(ctx: AppContext): JobDefinition {
  return Object.freeze({
    name: DISK_GUARD_JOB,
    schedules: [{ every: MINUTE_MS }],
    run: async () => {
      await ctx.diskGuard.check();
    },
  });
}

/**
 * Every job of the server process, in the order of the table above (`sqlite-maintenance` only on SQLite).
 * `startedAt` is the process start: the daily SQLite vacuum waits for the first daily run.
 */
export function serverJobs(ctx: AppContext, startedAt: number): readonly JobDefinition[] {
  return Object.freeze([
    retentionJob(ctx),
    authCleanupJob(ctx),
    accountPurgeJob(ctx),
    ...(ctx.db.dialect === "sqlite" ? [sqliteMaintenanceJob(ctx, startedAt)] : []),
    diskGuardJob(ctx),
  ]);
}

export function registerJobs(scheduler: Scheduler, ctx: AppContext): void {
  for (const job of serverJobs(ctx, ctx.clock.now())) scheduler.add(job);
}
