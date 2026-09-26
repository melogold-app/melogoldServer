/**
 * `sqlite-maintenance` (API §5, §9.4), SQLite only: `optimize` on every run; the daily heavy run gives freed pages
 * back (`incremental_vacuum`) and truncates the WAL, at most once per {@link HEAVY_EVERY_MS}.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { sql } from "kysely";
import type { JobRunContext } from "../../jobs/scheduler.ts";
import { HOUR_MS } from "../../lib/clock.ts";
import { createUser } from "../../test/factories.ts";
import { createTestApp } from "../../test/test-app.ts";
import type { TestApp } from "../../test/test-app.ts";
import { TEST_DIALECT } from "../../test/test-db.ts";
import {
  HEAVY_EVERY_MS,
  SQLITE_MAINTENANCE_JOB,
  runSqliteMaintenance,
  sqliteMaintenanceJob,
} from "./sqlite-maintenance.job.ts";

let t: TestApp;

before(async () => {
  t = await createTestApp();
});

after(async () => {
  await t.close();
});

async function freePages(): Promise<number> {
  const result = await t.db.run((q) => sql<{ freelist_count: number }>`PRAGMA freelist_count`.execute(q));
  return result.rows[0]?.freelist_count ?? 0;
}

function runContext(startedAt: number, messages: string[]): JobRunContext {
  return {
    name: SQLITE_MAINTENANCE_JOB,
    signal: new AbortController().signal,
    startedAt,
    log: {
      info: (_details, message) => messages.push(message),
      warn: (_details, message) => messages.push(message),
      error: (_details, message) => messages.push(message),
    },
  };
}

describe(`sqlite-maintenance (${TEST_DIALECT})`, { skip: TEST_DIALECT !== "sqlite" }, () => {
  test("the heavy run gives freed pages back to the file system", async () => {
    const users: { id: string }[] = [];
    for (let i = 0; i < 300; i++) users.push(await createUser(t.db, { now: t.clock.now() }));
    await t.db.write((q) =>
      q
        .deleteFrom("users")
        .where(
          "id",
          "in",
          users.map((user) => user.id),
        )
        .execute(),
    );
    assert.ok((await freePages()) > 0, "the deletes left free pages");

    const light = await runSqliteMaintenance(t.ctx, { heavy: false });
    assert.equal(light.heavy, false);
    assert.ok((await freePages()) > 0, "optimize alone keeps them");

    const heavy = await runSqliteMaintenance(t.ctx, { heavy: true });
    assert.equal(heavy.heavy, true);
    assert.ok(heavy.freedPages > 0);
    assert.equal(await freePages(), 0);
  });

  test("the job vacuums at most once per 20 h, counted from the process start", async () => {
    const start = t.clock.now();
    const job = sqliteMaintenanceJob(t.ctx, start);
    assert.deepEqual(
      job.schedules.map((schedule) => ("every" in schedule ? "every" : "daily")),
      ["every", "daily"],
    );
    const heavyAt = [6, 19, 20, 26, 39, 41].map((hours) => start + hours * HOUR_MS);
    const heavy: number[] = [];
    for (const at of heavyAt) {
      const messages: string[] = [];
      await job.run(runContext(at, messages));
      if (messages.length > 0) heavy.push((at - start) / HOUR_MS);
    }
    assert.equal(HEAVY_EVERY_MS, 20 * HOUR_MS);
    assert.deepEqual(heavy, [20, 41]);
  });
});
