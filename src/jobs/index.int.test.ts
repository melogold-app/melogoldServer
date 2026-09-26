/**
 * The job list of the server process (API §5), both dialects: the five jobs in order, `sqlite-maintenance` only on
 * SQLite, the schedules of the table in `index.ts`; `retention` runs the history step and the playback step.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "../lib/clock.ts";
import { createUser } from "../test/factories.ts";
import { createTestApp } from "../test/test-app.ts";
import type { TestApp } from "../test/test-app.ts";
import { TEST_DIALECT } from "../test/test-db.ts";
import { DISK_GUARD_JOB, RETENTION_JOB, serverJobs } from "./index.ts";

let t: TestApp;

before(async () => {
  t = await createTestApp({ env: { RETENTION_RUN_AT_UTC: "04:30", PLAYBACK_RETENTION_DAYS: "30" } });
});

after(async () => {
  await t.close();
});

describe(`server jobs (${TEST_DIALECT})`, () => {
  test("the five jobs of API §5 with their schedules", () => {
    const jobs = serverJobs(t.ctx, t.clock.now());
    const expected = [
      RETENTION_JOB,
      "auth-cleanup",
      "account-purge",
      ...(TEST_DIALECT === "sqlite" ? ["sqlite-maintenance"] : []),
      DISK_GUARD_JOB,
    ];
    assert.deepEqual(
      jobs.map((job) => job.name),
      expected,
    );
    const byName = new Map(jobs.map((job) => [job.name, job.schedules]));
    assert.deepEqual(byName.get(RETENTION_JOB), [{ dailyAt: { hour: 4, minute: 30 }, jitterMs: 10 * MINUTE_MS }]);
    assert.deepEqual(byName.get("auth-cleanup"), [{ every: HOUR_MS }]);
    assert.deepEqual(byName.get("account-purge"), [{ every: 15 * MINUTE_MS }]);
    assert.deepEqual(byName.get(DISK_GUARD_JOB), [{ every: MINUTE_MS }]);
  });

  test("retention deletes old playback states too", async () => {
    const now = t.clock.now();
    const user = await createUser(t.db, { now: now - 60 * DAY_MS });
    await t.db.write((q) =>
      q
        .insertInto("playback_state")
        .values({
          user_id: user.id,
          rev: 1,
          device_id: "00000000-0000-4000-8000-000000000001",
          device_name: "Pixel",
          session_id: "00000000-0000-4000-8000-000000000002",
          queue_version: 1,
          queue: "[]",
          idx: 0,
          position_ms: 0,
          playing: 0,
          state_at: now - 40 * DAY_MS,
          updated_at: now - 40 * DAY_MS,
        })
        .execute(),
    );
    const retention = serverJobs(t.ctx, now).find((job) => job.name === RETENTION_JOB);
    assert.ok(retention);
    await retention.run({
      name: RETENTION_JOB,
      signal: new AbortController().signal,
      startedAt: now,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });
    const left = await t.db.run((q) =>
      q.selectFrom("playback_state").select("user_id").where("user_id", "=", user.id).executeTakeFirst(),
    );
    assert.equal(left, undefined);
  });
});
