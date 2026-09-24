/**
 * `playback` retention (DESIGN §3.12.3 "Строки старше 30 дней удаляет retention"), on both dialects. This is one
 * `db.write` DELETE, so it doubles as the "each new SQL query has an integration test" coverage of
 * `deletePlaybackStateOlderThan` (docs/database.md §8).
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { deleteInBatches } from "../../db/batch.ts";
import type { Db } from "../../db/index.ts";
import { DAY_MS } from "../../lib/clock.ts";
import { createUser } from "../../test/factories.ts";
import { createMigratedTestDatabase } from "../../test/test-db.ts";
import type { MigratedTestDatabase } from "../../test/test-db.ts";
import { deletePlaybackStateOlderThan } from "./playback.repository.ts";
import {
  createPlaybackRetentionJob,
  PLAYBACK_RETENTION_JOB_NAME,
  runPlaybackRetention,
} from "./playback-retention.job.ts";

let migrated: MigratedTestDatabase;
let db: Db;

// A fresh database per test: `deletePlaybackStateOlderThan` has no per-user scope on its own, so tests must not see
// each other's rows.
beforeEach(async () => {
  migrated = await createMigratedTestDatabase();
  db = migrated.db;
});

afterEach(async () => {
  await db.destroy();
  await migrated.database.cleanup();
});

async function insertRow(userId: string, updatedAt: number): Promise<void> {
  await db.write((q) =>
    q
      .insertInto("playback_state")
      .values({
        user_id: userId,
        rev: updatedAt,
        cleared: 0,
        device_id: "11111111-1111-4111-8111-111111111111",
        device_name: null,
        session_id: "22222222-2222-4222-8222-222222222222",
        queue_version: 0,
        queue: "[]",
        idx: 0,
        position_ms: 0,
        duration_ms: null,
        playing: 0,
        state_at: updatedAt,
        updated_at: updatedAt,
        handoff_device_id: null,
        handoff_session_id: null,
        handoff_at: null,
      })
      .execute(),
  );
}

async function userIds(): Promise<string[]> {
  const rows = await db.run((q) => q.selectFrom("playback_state").select("user_id").execute());
  return rows.map((row) => row.user_id).sort();
}

describe("deletePlaybackStateOlderThan", () => {
  test("deletes only rows whose updated_at is strictly before the cutoff, batch by batch", async () => {
    const now = Date.UTC(2026, 8, 23);
    const cutoff = now - 30 * DAY_MS;
    const recent = await createUser(db, { now });
    const old1 = await createUser(db, { now });
    const old2 = await createUser(db, { now });

    await insertRow(recent.id, cutoff + 1); // kept: not old enough
    await insertRow(old1.id, cutoff - 1); // deleted
    await insertRow(old2.id, cutoff - 2000); // deleted

    // batchSize: 1 forces two separate `db.write` batches, exercising deleteInBatches' loop.
    const deleted = await deleteInBatches((limit) => db.write((q) => deletePlaybackStateOlderThan(q, cutoff, limit)), {
      batchSize: 1,
    });
    assert.equal(deleted, 2);
    assert.deepEqual(await userIds(), [recent.id]);
  });

  test("a row exactly at the cutoff is kept (strictly before, not at or before)", async () => {
    const now = Date.UTC(2026, 9, 1);
    const cutoff = now - 30 * DAY_MS;
    const user = await createUser(db, { now });
    await insertRow(user.id, cutoff);

    const deleted = await db.write((q) => deletePlaybackStateOlderThan(q, cutoff, 5000));
    assert.equal(deleted, 0);
    assert.deepEqual(await userIds(), [user.id]);
  });
});

describe("runPlaybackRetention / createPlaybackRetentionJob", () => {
  test("the job's schedule is a daily run at RETENTION_RUN_AT_UTC with a 10 min jitter", () => {
    const job = createPlaybackRetentionJob({
      clock: { now: () => 0 },
      db,
      env: { PLAYBACK_RETENTION_DAYS: 30, RETENTION_RUN_AT_UTC: { hour: 4, minute: 30 } },
    });
    assert.equal(job.name, PLAYBACK_RETENTION_JOB_NAME);
    assert.deepEqual(job.schedules, [{ dailyAt: { hour: 4, minute: 30 }, jitterMs: 600_000 }]);
  });

  test("runPlaybackRetention uses PLAYBACK_RETENTION_DAYS as the cutoff", async () => {
    const now = Date.UTC(2027, 0, 1);
    const retentionDays = 7;
    const cutoff = now - retentionDays * DAY_MS;
    const recent = await createUser(db, { now });
    const old = await createUser(db, { now });
    await insertRow(recent.id, cutoff + DAY_MS);
    await insertRow(old.id, cutoff - DAY_MS);

    const deleted = await runPlaybackRetention({
      clock: { now: () => now },
      db,
      env: { PLAYBACK_RETENTION_DAYS: retentionDays, RETENTION_RUN_AT_UTC: { hour: 4, minute: 30 } },
    });
    assert.equal(deleted, 1);
    assert.deepEqual(await userIds(), [recent.id]);
  });
});
