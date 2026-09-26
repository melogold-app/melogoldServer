/**
 * `auth-cleanup` (API §5: hourly; DESIGN §4.12: batches of 1000), in this order:
 *
 * 1. `refresh_tokens` expired more than a day ago, or rotated/revoked with their grace window over more than a day
 *    ago;
 * 2. `device_links` expired more than an hour ago;
 * 3. `auth_throttle` rows older than a day without an active lock;
 * 4. inactive devices, through `removeDevicesInTx` ({@link removeInactiveDevices}, `src/modules/devices`).
 *
 * Every batch is its own short `db.write`, so the SQLite writer is free between batches. Like every job it publishes
 * no SSE event (API §5) and stops between batches when the server stops.
 */
import type { AppContext } from "../../context.ts";
import { deleteInBatches } from "../../db/batch.ts";
import type { JobDefinition, JobRunContext } from "../../jobs/scheduler.ts";
import { DAY_MS, HOUR_MS } from "../../lib/clock.ts";
import { removeInactiveDevices } from "../devices/inactive.job.ts";
import { deleteExpiredLinks, deleteStaleRefreshTokens, deleteStaleThrottle } from "./maintenance.repository.ts";

export const AUTH_CLEANUP_JOB = "auth-cleanup";
export const AUTH_CLEANUP_INTERVAL_MS = HOUR_MS;
/** DESIGN §4.12. */
export const AUTH_CLEANUP_BATCH = 1000;

export type AuthCleanupContext = Pick<AppContext, "db" | "clock" | "env" | "devices">;

export type AuthCleanupOptions = Readonly<{
  /** Epoch ms the cutoffs are computed from (the job's `startedAt`). */
  now: number;
  signal?: AbortSignal;
  batchSize?: number;
}>;

export type AuthCleanupReport = Readonly<{
  refreshTokens: number;
  links: number;
  throttle: number;
  inactiveDevices: number;
}>;

/** One run of the cleanup (steps 1–4 above); stops between batches once `signal` is aborted. */
export async function runAuthCleanup(ctx: AuthCleanupContext, options: AuthCleanupOptions): Promise<AuthCleanupReport> {
  const { now, signal } = options;
  const batchSize = options.batchSize ?? AUTH_CLEANUP_BATCH;
  const stopped = () => signal?.aborted === true;
  const batches = (deleteBatch: (limit: number) => Promise<number>) =>
    stopped()
      ? Promise.resolve(0)
      : deleteInBatches((limit) => (stopped() ? Promise.resolve(0) : deleteBatch(limit)), { batchSize });

  const refreshTokens = await batches((limit) => ctx.db.write((q) => deleteStaleRefreshTokens(q, now - DAY_MS, limit)));
  const links = await batches((limit) => ctx.db.write((q) => deleteExpiredLinks(q, now - HOUR_MS, limit)));
  const throttle = await batches((limit) => ctx.db.write((q) => deleteStaleThrottle(q, now - DAY_MS, now, limit)));
  const inactiveDevices = stopped()
    ? 0
    : await removeInactiveDevices(ctx, { batchSize, ...(signal ? { signal } : {}) });
  return Object.freeze({ refreshTokens, links, throttle, inactiveDevices });
}

/** The scheduler entry of `auth-cleanup`. */
export function authCleanupJob(ctx: AuthCleanupContext): JobDefinition {
  return Object.freeze({
    name: AUTH_CLEANUP_JOB,
    schedules: [{ every: AUTH_CLEANUP_INTERVAL_MS }],
    run: async (job: JobRunContext) => {
      const report = await runAuthCleanup(ctx, { now: job.startedAt, signal: job.signal });
      if (Object.values(report).some((count) => count > 0))
        job.log.info({ job: job.name, ...report }, "auth cleanup finished");
    },
  });
}
