/**
 * `history.clear` on the migrated schema, both dialects (DESIGN §3.7, §3.11.5): the `'*'` mark only grows, is
 * clamped to `now`, deletes in-history events up to and including the mark in batches, and never touches totals.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Kysely } from "kysely";
import { ALL_VIDEOS, SyncOpEnvelope } from "../../../contract/sync.ts";
import { insertHead, lockUser } from "../../../db/heads.ts";
import type { Database, Db } from "../../../db/index.ts";
import { DELETE_BATCH_ROWS, insertInChunks } from "../../../db/batch.ts";
import { HOUR_MS, MINUTE_MS } from "../../../lib/clock.ts";
import { newId } from "../../../lib/ids.ts";
import { TEST_DIALECT, createMigratedTestDatabase } from "../../../test/test-db.ts";
import type { TestDatabase } from "../../../test/test-db.ts";
import { createTestOpCtx } from "./op-test-harness.ts";
import { historyClearHandler } from "./history-clear.ts";
import type { WireOp } from "./types.ts";

const NOW = Date.UTC(2026, 8, 24, 10, 0, 0);
const VIDEO_A = "a1B2c3D4e5F";
const DEVICE_ID = "22222222-2222-4222-8222-222222222222";

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

function wireClear(fields: Readonly<{ opId?: string; at: number; eventsBefore: number }>): WireOp {
  return SyncOpEnvelope.parse({
    opId: fields.opId ?? newId(),
    kind: "history.clear",
    at: new Date(fields.at).toISOString(),
    eventsBefore: new Date(fields.eventsBefore).toISOString(),
  });
}

async function applyClear(q: Kysely<Database>, userId: string, fields: Parameters<typeof wireClear>[0]) {
  const head = await lockUser(q, userId);
  const oc = createTestOpCtx({ q, userId, deviceId: DEVICE_ID, head, now: NOW });
  const raw = wireClear(fields);
  const parsed = historyClearHandler.parse(raw);
  assert.ok(parsed.ok, "history.clear must parse");
  const outcome = await historyClearHandler.apply(oc, parsed.value, {
    effAt: Math.min(parsed.value.at, oc.now),
    base: null,
  });
  return { raw, outcome, oc };
}

async function forgetMark(userId: string) {
  return db.read((q) =>
    q
      .selectFrom("play_forgets")
      .selectAll()
      .where("user_id", "=", userId)
      .where("video_id", "=", ALL_VIDEOS)
      .executeTakeFirst(),
  );
}

/** Inserts `count` real in-history play_events rows directly (bypassing play.add), spread one second apart. */
async function seedHistory(q: Kysely<Database>, userId: string, count: number, startedAt: number): Promise<void> {
  const head = await lockUser(q, userId);
  const rows = Array.from({ length: count }, (_, i) => ({
    user_id: userId,
    event_id: newId(),
    video_id: VIDEO_A,
    played_at: startedAt + i * 1000,
    play_time_ms: 6000,
    in_history: 1 as const,
    counts_playtime: 1 as const,
    device_id: DEVICE_ID,
    seq: head.seq + 1 + i,
    received_at: startedAt + i * 1000,
  }));
  await insertInChunks(rows, (chunk) => q.insertInto("play_events").values(chunk).execute());
  await q
    .updateTable("sync_heads")
    .set({ seq: head.seq + count })
    .where("user_id", "=", userId)
    .execute();
}

describe(`history.clear (${TEST_DIALECT})`, () => {
  test("first clear: writes the '*' mark and deletes in-history events at or before it", async () => {
    const userId = await makeUser();
    await db.write((q) => seedHistory(q, userId, 3, NOW - 3 * HOUR_MS)); // played at -3h, -3h+1s, -3h+2s
    const mark = NOW - 2 * HOUR_MS;
    const { outcome, oc } = await db.write((q) => applyClear(q, userId, { at: NOW, eventsBefore: mark }));
    assert.deepEqual(outcome, { status: "applied" });
    // A journaled op's own outcome never carries a seq (types.ts: only play.add's `applied({seq})` is final; the
    // runner allocates the sync_ops row's seq afterwards). The register write itself still spent one, though.
    assert.ok(oc.seq > 0, "writePlayForget called oc.next()");
    const forget = await forgetMark(userId);
    assert.equal(forget?.events_before, mark);
    assert.equal(forget.total_before, null);
    assert.equal(forget.seq, oc.seq);
    const remaining = await db.read((q) =>
      q.selectFrom("play_events").select("played_at").where("user_id", "=", userId).execute(),
    );
    assert.equal(remaining.length, 0, "all three plays are at or before -2h");
  });

  test("the mark is inclusive: an event played exactly at eventsBefore is deleted", async () => {
    const userId = await makeUser();
    const playedAt = NOW - HOUR_MS;
    await db.write((q) => seedHistory(q, userId, 1, playedAt));
    await db.write((q) => applyClear(q, userId, { at: NOW, eventsBefore: playedAt }));
    const remaining = await db.read((q) =>
      q.selectFrom("play_events").select("played_at").where("user_id", "=", userId).execute(),
    );
    assert.equal(remaining.length, 0);
  });

  test("clamped to now: a future eventsBefore only clears up to the current time", async () => {
    const userId = await makeUser();
    await db.write((q) => seedHistory(q, userId, 1, NOW));
    const { outcome } = await db.write((q) => applyClear(q, userId, { at: NOW, eventsBefore: NOW + HOUR_MS }));
    assert.equal(outcome.status, "applied");
    const forget = await forgetMark(userId);
    assert.equal(forget?.events_before, NOW, "clamped to now, not the requested future mark");
  });

  test("the mark only grows: a smaller eventsBefore afterwards is a no-op (no seq, mark unchanged)", async () => {
    const userId = await makeUser();
    await db.write((q) => applyClear(q, userId, { at: NOW, eventsBefore: NOW }));
    const grownMark = (await forgetMark(userId))?.events_before;
    assert.equal(grownMark, NOW);
    const { outcome } = await db.write((q) => applyClear(q, userId, { at: NOW, eventsBefore: NOW - HOUR_MS }));
    assert.deepEqual(outcome, { status: "applied" }); // no seq: nothing changed
    assert.equal((await forgetMark(userId))?.events_before, NOW, "the mark did not move backwards");
  });

  test("a later clear raises the mark again and deletes newly-eligible events", async () => {
    const userId = await makeUser();
    await db.write((q) => seedHistory(q, userId, 1, NOW - MINUTE_MS));
    await db.write((q) => applyClear(q, userId, { at: NOW, eventsBefore: NOW - 2 * HOUR_MS }));
    assert.equal(
      (await db.read((q) => q.selectFrom("play_events").select("event_id").where("user_id", "=", userId).execute()))
        .length,
      1,
      "not old enough yet",
    );
    await db.write((q) => applyClear(q, userId, { at: NOW, eventsBefore: NOW }));
    assert.equal(
      (await db.read((q) => q.selectFrom("play_events").select("event_id").where("user_id", "=", userId).execute()))
        .length,
      0,
    );
  });

  test("totals are not touched (DESIGN §3.11.5)", async () => {
    const userId = await makeUser();
    await db.write(async (q) => {
      const head = await lockUser(q, userId);
      await q
        .insertInto("play_stats")
        .values({
          user_id: userId,
          video_id: VIDEO_A,
          total_ms: 42_000,
          last_played_at: NOW - HOUR_MS,
          seq: head.seq + 1,
        })
        .execute();
      await q
        .updateTable("sync_heads")
        .set({ seq: head.seq + 1 })
        .where("user_id", "=", userId)
        .execute();
    });
    await db.write((q) => applyClear(q, userId, { at: NOW, eventsBefore: NOW }));
    const stat = await db.read((q) =>
      q
        .selectFrom("play_stats")
        .selectAll()
        .where("user_id", "=", userId)
        .where("video_id", "=", VIDEO_A)
        .executeTakeFirstOrThrow(),
    );
    assert.equal(stat.total_ms, 42_000);
    assert.equal(stat.last_played_at, NOW - HOUR_MS);
  });

  test("batched deletion: more in-history rows than one DELETE batch are all removed", async () => {
    const userId = await makeUser();
    const count = DELETE_BATCH_ROWS + 1;
    await db.write((q) => seedHistory(q, userId, count, NOW - 10 * HOUR_MS));
    const before = await db.read((q) =>
      q
        .selectFrom("play_events")
        .select((eb) => eb.fn.countAll().as("n"))
        .where("user_id", "=", userId)
        .executeTakeFirstOrThrow(),
    );
    assert.equal(Number(before.n), count);
    await db.write((q) => applyClear(q, userId, { at: NOW, eventsBefore: NOW }));
    const after = await db.read((q) =>
      q
        .selectFrom("play_events")
        .select((eb) => eb.fn.countAll().as("n"))
        .where("user_id", "=", userId)
        .executeTakeFirstOrThrow(),
    );
    assert.equal(Number(after.n), 0, "both batches of the delete loop ran");
  });

  test("touch always adds the '*' key", async () => {
    const userId = await makeUser();
    const { oc, raw } = await db.write((q) => applyClear(q, userId, { at: NOW, eventsBefore: NOW }));
    historyClearHandler.touch(raw, oc.touched);
    assert.deepEqual([...oc.touched.playForgets], [ALL_VIDEOS]);
  });
});
