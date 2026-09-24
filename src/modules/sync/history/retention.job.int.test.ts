/**
 * The history retention job on the migrated schema, both dialects (DESIGN §3.11.6; API §5): idempotency rows past
 * 30 days, `sync_ops` past `SYNC_OPS_RETENTION_DAYS`, and per-user in-history events past `HISTORY_RETENTION_DAYS`
 * or above `HISTORY_MAX_EVENTS`, paginated by keyset over `sync_heads`. Retention never moves `seq` (no `lockUser`,
 * no `bumpHead`): it is not a deletion for clients (DESIGN §3.8).
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Kysely } from "kysely";
import { insertHead, lockUser, readHead } from "../../../db/heads.ts";
import type { Database, Db } from "../../../db/index.ts";
import { DAY_MS, HOUR_MS } from "../../../lib/clock.ts";
import { newId } from "../../../lib/ids.ts";
import { TEST_DIALECT, createMigratedTestDatabase } from "../../../test/test-db.ts";
import type { TestDatabase } from "../../../test/test-db.ts";
import { IDEMPOTENCY_RETENTION_DAYS, runHistoryRetention } from "./retention.job.ts";
import type { HistoryRetentionContext } from "./retention.job.ts";

const NOW = Date.UTC(2026, 8, 24, 10, 0, 0);
const DEVICE_ID = "22222222-2222-4222-8222-222222222222";
const VIDEO_A = "a1B2c3D4e5F";

let database: TestDatabase;
let db: Db;

before(async () => {
  ({ database, db } = await createMigratedTestDatabase());
});

after(async () => {
  await db.destroy();
  await database.cleanup();
});

async function insertUser(q: Kysely<Database>, id: string): Promise<void> {
  await q
    .insertInto("users")
    .values({
      id,
      login: `login-${id.slice(0, 8)}`,
      password_hash: "$argon2id$stub",
      password_changed_at: NOW,
      recovery_code_hash: "0".repeat(64),
      recovery_code_created_at: NOW,
      created_at: NOW,
      updated_at: NOW,
    })
    .execute();
}

async function makeUser(): Promise<string> {
  const id = newId();
  await db.write(async (q) => {
    await insertUser(q, id);
    await insertHead(q, id, NOW);
  });
  return id;
}

async function seedEvent(
  userId: string,
  fields: Readonly<{ playedAt: number; receivedAt: number; inHistory: 0 | 1 }>,
): Promise<void> {
  await db.write(async (q) => {
    const head = await lockUser(q, userId);
    const seq = fields.inHistory === 1 ? head.seq + 1 : null;
    await q
      .insertInto("play_events")
      .values({
        user_id: userId,
        event_id: newId(),
        video_id: VIDEO_A,
        played_at: fields.playedAt,
        play_time_ms: 6000,
        in_history: fields.inHistory,
        counts_playtime: 1,
        device_id: DEVICE_ID,
        seq,
        received_at: fields.receivedAt,
      })
      .execute();
    if (seq !== null) await q.updateTable("sync_heads").set({ seq }).where("user_id", "=", userId).execute();
  });
}

async function seedSyncOp(userId: string, serverAt: number): Promise<void> {
  await db.write(async (q) => {
    const head = await lockUser(q, userId);
    const seq = head.seq + 1;
    await q
      .insertInto("sync_ops")
      .values({
        user_id: userId,
        seq,
        op_id: newId(),
        device_id: DEVICE_ID,
        device_name: null,
        kind: "like.set",
        payload: "{}",
        status: "applied",
        code: null,
        result: null,
        client_at: serverAt,
        eff_at: serverAt,
        base_seq: null,
        pre_image: null,
        server_at: serverAt,
      })
      .execute();
    await q.updateTable("sync_heads").set({ seq }).where("user_id", "=", userId).execute();
  });
}

function eventCount(userId: string): Promise<number> {
  return db
    .read((q) =>
      q
        .selectFrom("play_events")
        .select((eb) => eb.fn.countAll().as("n"))
        .where("user_id", "=", userId)
        .executeTakeFirstOrThrow(),
    )
    .then((row) => Number(row.n));
}

function syncOpCount(userId: string): Promise<number> {
  return db
    .read((q) =>
      q
        .selectFrom("sync_ops")
        .select((eb) => eb.fn.countAll().as("n"))
        .where("user_id", "=", userId)
        .executeTakeFirstOrThrow(),
    )
    .then((row) => Number(row.n));
}

/** Built lazily: `db` is only assigned once the `before` hook has run. */
function defaultCtx(): HistoryRetentionContext {
  return { db, env: { HISTORY_RETENTION_DAYS: 366, HISTORY_MAX_EVENTS: 50_000, SYNC_OPS_RETENTION_DAYS: 30 } };
}

describe(`history retention job (${TEST_DIALECT})`, () => {
  test("idempotency: in_history=0 rows past 30 days are deleted, newer ones are kept", async () => {
    const userId = await makeUser();
    await seedEvent(userId, {
      playedAt: NOW - HOUR_MS,
      receivedAt: NOW - IDEMPOTENCY_RETENTION_DAYS * DAY_MS - 1,
      inHistory: 0,
    });
    await seedEvent(userId, { playedAt: NOW - HOUR_MS, receivedAt: NOW - DAY_MS, inHistory: 0 });
    const result = await runHistoryRetention(defaultCtx(), { now: NOW });
    assert.equal(result.idempotencyEvents, 1);
    assert.equal(await eventCount(userId), 1);
  });

  test("sync_ops: rows past SYNC_OPS_RETENTION_DAYS are deleted, newer ones stay", async () => {
    const userId = await makeUser();
    await seedSyncOp(userId, NOW - 31 * DAY_MS);
    await seedSyncOp(userId, NOW - DAY_MS);
    const result = await runHistoryRetention(defaultCtx(), { now: NOW });
    assert.equal(result.syncOps, 1);
    assert.equal(await syncOpCount(userId), 1);
  });

  test("per-user: in-history events past HISTORY_RETENTION_DAYS are deleted, newer ones stay", async () => {
    const userId = await makeUser();
    const cutoff = NOW - 366 * DAY_MS;
    await seedEvent(userId, { playedAt: cutoff - 1, receivedAt: cutoff - 1, inHistory: 1 });
    await seedEvent(userId, { playedAt: cutoff, receivedAt: cutoff, inHistory: 1 }); // exactly at cutoff: inclusive
    await seedEvent(userId, { playedAt: NOW - DAY_MS, receivedAt: NOW - DAY_MS, inHistory: 1 });
    const result = await runHistoryRetention(defaultCtx(), { now: NOW });
    assert.equal(result.expiredEvents, 2);
    assert.equal(await eventCount(userId), 1);
  });

  test("per-user: in-history events above HISTORY_MAX_EVENTS are trimmed to the cap, oldest first", async () => {
    const userId = await makeUser();
    const cap = 3;
    for (let i = 0; i < cap + 2; i++) {
      await seedEvent(userId, { playedAt: NOW - (cap + 2 - i) * HOUR_MS, receivedAt: NOW, inHistory: 1 });
    }
    const ctx: HistoryRetentionContext = { db, env: { ...defaultCtx().env, HISTORY_MAX_EVENTS: cap } };
    const result = await runHistoryRetention(ctx, { now: NOW });
    assert.equal(result.excessEvents, 2);
    const remaining = await db.read((q) =>
      q.selectFrom("play_events").select("played_at").where("user_id", "=", userId).orderBy("played_at").execute(),
    );
    assert.equal(remaining.length, cap);
    assert.ok(
      remaining.every((row) => row.played_at > NOW - (cap + 1) * HOUR_MS),
      "the two oldest were trimmed",
    );
  });

  test("retention does not spend a seq (no lockUser, no bumpHead)", async () => {
    const userId = await makeUser();
    await seedEvent(userId, { playedAt: NOW - HOUR_MS, receivedAt: NOW, inHistory: 1 });
    const before = await db.read((q) => readHead(q, userId));
    assert.equal(before.seq, 1, "seedEvent's own write bumped the head to 1");
    // A far-future "now" so this user's just-seeded row is certainly past HISTORY_RETENTION_DAYS (this also expires
    // any leftover rows of other users from earlier tests in this file, so only this user's own state is checked).
    await runHistoryRetention(defaultCtx(), { now: NOW + 500 * DAY_MS });
    assert.equal(await eventCount(userId), 0, "the seeded event was in fact deleted");
    const after = await db.read((q) => readHead(q, userId));
    assert.equal(after.seq, before.seq, "retention deleted the row without moving the head");
  });

  test("keyset pagination visits every user (small userPageSize, several users)", async () => {
    const users = await Promise.all([makeUser(), makeUser(), makeUser()]);
    const cutoff = NOW - 366 * DAY_MS;
    for (const userId of users) {
      await seedEvent(userId, { playedAt: cutoff - 1, receivedAt: NOW, inHistory: 1 });
    }
    const result = await runHistoryRetention(defaultCtx(), { now: NOW, userPageSize: 1 });
    assert.equal(result.expiredEvents, users.length);
    for (const userId of users) {
      assert.equal(await eventCount(userId), 0, userId);
    }
  });

  test("an aborted signal stops the run early and reports stopped:true", async () => {
    const userId = await makeUser();
    await seedEvent(userId, {
      playedAt: NOW - HOUR_MS,
      receivedAt: NOW - IDEMPOTENCY_RETENTION_DAYS * DAY_MS - 1,
      inHistory: 0,
    });
    const controller = new AbortController();
    controller.abort();
    const result = await runHistoryRetention(defaultCtx(), { now: NOW, signal: controller.signal });
    assert.equal(result.stopped, true);
    assert.equal(result.idempotencyEvents, 0);
    assert.equal(result.syncOps, 0);
    assert.equal(result.expiredEvents, 0);
    assert.equal(result.excessEvents, 0);
    assert.equal(await eventCount(userId), 1, "nothing was deleted once aborted");
  });
});
