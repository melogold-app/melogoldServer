/**
 * The `account-purge` background job (API §5: every 15 minutes; DESIGN §4.11): after `POST /auth/me/delete` marked an
 * account deleted, this job removes its data.
 *
 * - Accounts are taken in `(deleted_at, id)` order from the partial index `users_deleted`.
 * - For each one, every table of {@link PURGE_TABLES} is emptied in batches of at most {@link DELETE_BATCH_ROWS} rows,
 *   **each batch its own short `db.write`** that starts with `lockUser` (the batch deletes rows of the user's state,
 *   so it is serialized with any write of that user still in flight). Between batches the event loop gets a turn, so
 *   the single SQLite writer is free for HTTP requests.
 * - The last transaction deletes `sync_heads` and the `users` row; the login was freed already at deletion time.
 * - A failing account is logged and skipped (the next run retries it); the run stops between batches when the
 *   server shuts down (`signal`).
 *
 * Jobs publish no SSE and never move `seq` (API §5). The scheduler registration lives in `src/jobs/index.ts` (T3.1):
 * `scheduler.add(accountPurgeJob(ctx))`.
 */
import type { AppContext } from "../../context.ts";
import { DELETE_BATCH_ROWS, deleteInBatches } from "../../db/batch.ts";
import type { BatchLoopOptions } from "../../db/batch.ts";
import { lockUser } from "../../db/heads.ts";
import type { Db } from "../../db/index.ts";
import type { JobDefinition, JobLogger } from "../../jobs/scheduler.ts";
import { MINUTE_MS } from "../../lib/clock.ts";
import { PURGE_TABLES, deleteDeletedUser, listDeletedUsers, purgeBatch } from "./account.repository.ts";

type DeletedUser = Readonly<{ id: string; deleted_at: number }>;

export { PURGE_TABLES };

export const ACCOUNT_PURGE_JOB = "account-purge";
/** API §5: `account-purge` every 15 minutes. */
export const ACCOUNT_PURGE_INTERVAL_MS = 15 * MINUTE_MS;
/** Deleted accounts read per page. */
export const PURGE_ACCOUNTS_PAGE = 100;

export type PurgeDeps = Readonly<{
  db: Pick<Db, "run" | "write">;
  log: Pick<JobLogger, "info" | "error">;
}>;

export type PurgeOptions = Readonly<{
  /** Stops between batches when aborted (server shutdown). */
  signal?: AbortSignal;
  /** Rows per batch transaction (default {@link DELETE_BATCH_ROWS}). */
  batchSize?: number;
  /** Lets other work take the writer between batches (default: `setImmediate`). */
  yieldBetween?: BatchLoopOptions["yieldBetween"];
}>;

export type PurgeReport = Readonly<{
  /** Accounts whose `users` row is gone now. */
  purgedAccounts: number;
  /** Child rows deleted, over all accounts and tables. */
  deletedRows: number;
  /** Accounts that failed (retried by the next run). */
  failedAccounts: number;
}>;

class PurgeStopped extends Error {
  constructor() {
    super("account purge stopped");
    this.name = "PurgeStopped";
  }
}

/** Purges one deleted account; returns the number of child rows deleted. */
async function purgeAccount(deps: PurgeDeps, userId: string, options: PurgeOptions): Promise<number> {
  const batchSize = options.batchSize ?? DELETE_BATCH_ROWS;
  let deleted = 0;
  for (const { table } of PURGE_TABLES) {
    deleted += await deleteInBatches(
      async (limit) => {
        if (options.signal?.aborted === true) throw new PurgeStopped();
        return deps.db.write(async (q) => {
          await lockUser(q, userId);
          return purgeBatch(q, table, userId, limit);
        });
      },
      { batchSize, ...(options.yieldBetween ? { yieldBetween: options.yieldBetween } : {}) },
    );
  }
  if (options.signal?.aborted === true) throw new PurgeStopped();
  await deps.db.write(async (q) => {
    await lockUser(q, userId);
    await deleteDeletedUser(q, userId);
  });
  return deleted;
}

/** One run of the job: purges every account deleted so far. */
export async function purgeDeletedAccounts(deps: PurgeDeps, options: PurgeOptions = {}): Promise<PurgeReport> {
  let purgedAccounts = 0;
  let deletedRows = 0;
  let failedAccounts = 0;
  let after: Readonly<{ deletedAt: number; id: string }> | null = null;
  try {
    for (;;) {
      const cursor = after;
      const page: readonly DeletedUser[] = await deps.db.run((q) => listDeletedUsers(q, cursor, PURGE_ACCOUNTS_PAGE));
      for (const account of page) {
        if (options.signal?.aborted === true) throw new PurgeStopped();
        try {
          deletedRows += await purgeAccount(deps, account.id, options);
          purgedAccounts += 1;
        } catch (error) {
          if (error instanceof PurgeStopped) throw error;
          failedAccounts += 1;
          deps.log.error({ err: error, userId: account.id }, "account purge failed; the next run retries it");
        }
      }
      const last = page.at(-1);
      if (page.length < PURGE_ACCOUNTS_PAGE || last === undefined) break;
      after = { deletedAt: last.deleted_at, id: last.id };
    }
  } catch (error) {
    if (!(error instanceof PurgeStopped)) throw error;
  }
  const report = Object.freeze({ purgedAccounts, deletedRows, failedAccounts });
  if (purgedAccounts > 0 || failedAccounts > 0) deps.log.info({ ...report }, "deleted accounts purged");
  return report;
}

/** The scheduler entry of `account-purge` (API §5). */
export function accountPurgeJob(ctx: Pick<AppContext, "db">): JobDefinition {
  return Object.freeze({
    name: ACCOUNT_PURGE_JOB,
    schedules: [{ every: ACCOUNT_PURGE_INTERVAL_MS }],
    run: async (job) => {
      await purgeDeletedAccounts({ db: ctx.db, log: job.log }, { signal: job.signal });
    },
  });
}
