/**
 * `playback` row retention (DESIGN §3.12.3 "Строки старше 30 дней удаляет retention", API §5, §10:
 * `PLAYBACK_RETENTION_DAYS`, default 30): a background job, never SSE, never `seq`.
 *
 * This file only builds the {@link JobDefinition}; **T3.1 registers it** in `src/jobs/index.ts` (that file is owned
 * by T3.1 after M0, PLAN M2/M3 graph) alongside `history`'s own retention job, both on the daily `RETENTION_RUN_AT_UTC`
 * schedule (API §5 "±10 мин, пачками по 5000").
 */
import type { UtcTimeOfDay } from "../../config/env.ts";
import { deleteInBatches } from "../../db/batch.ts";
import type { Db } from "../../db/index.ts";
import { DAY_MS } from "../../lib/clock.ts";
import type { Clock } from "../../lib/clock.ts";
import type { JobDefinition } from "../../jobs/scheduler.ts";
import { deletePlaybackStateOlderThan } from "./playback.repository.ts";

export const PLAYBACK_RETENTION_JOB_NAME = "playback-retention";
/** DESIGN §3.15's ±10 min jitter reused for every `dailyAt` job (API §5). */
export const RETENTION_JITTER_MS = 10 * 60_000;

/** What this job needs; `AppContext` satisfies it structurally (tests build a smaller fake). */
export type PlaybackRetentionDeps = Readonly<{
  clock: Pick<Clock, "now">;
  db: Pick<Db, "write">;
  env: Readonly<{ PLAYBACK_RETENTION_DAYS: number; RETENTION_RUN_AT_UTC: UtcTimeOfDay }>;
}>;

/** Deletes every `playback_state` row untouched for `PLAYBACK_RETENTION_DAYS`, in batches of 5000. */
export async function runPlaybackRetention(deps: PlaybackRetentionDeps): Promise<number> {
  const cutoffMs = deps.clock.now() - deps.env.PLAYBACK_RETENTION_DAYS * DAY_MS;
  return deleteInBatches((limit) => deps.db.write((q) => deletePlaybackStateOlderThan(q, cutoffMs, limit)));
}

export function createPlaybackRetentionJob(deps: PlaybackRetentionDeps): JobDefinition {
  return {
    name: PLAYBACK_RETENTION_JOB_NAME,
    schedules: [{ dailyAt: deps.env.RETENTION_RUN_AT_UTC, jitterMs: RETENTION_JITTER_MS }],
    run: async () => {
      await runPlaybackRetention(deps);
    },
  };
}
