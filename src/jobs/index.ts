/**
 * The background jobs of the server process (API §5): registered on the scheduler by `server.ts` before it starts.
 *
 * M0 registers only `disk-guard` (every minute, DESIGN §3.10). T3.1 owns this file after M0 and adds `retention`,
 * `auth-cleanup`, `account-purge`, `sqlite-maintenance` and the jobs of the modules (PLAN T3.1).
 */
import type { AppContext } from "../context.ts";
import { MINUTE_MS } from "../lib/clock.ts";
import type { Scheduler } from "./scheduler.ts";

export const DISK_GUARD_JOB = "disk-guard";

export function registerJobs(scheduler: Scheduler, ctx: AppContext): void {
  scheduler.add({
    name: DISK_GUARD_JOB,
    schedules: [{ every: MINUTE_MS }],
    run: async () => {
      await ctx.diskGuard.check();
    },
  });
}
