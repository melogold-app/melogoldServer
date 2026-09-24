/**
 * `history.forget` on the migrated schema, both dialects (DESIGN §3.7, §3.11.5): «Убрать из Quick Picks»
 * (`resetTotal:false`, only the track's history goes) and «Скрыть» (`resetTotal:true`, the total also resets to 0),
 * each mark growing independently, and the total never zeroed twice.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Kysely } from "kysely";
import { SyncOpEnvelope } from "../../../contract/sync.ts";
import { insertHead, lockUser } from "../../../db/heads.ts";
import type { Database, Db } from "../../../db/index.ts";
import { HOUR_MS, MINUTE_MS } from "../../../lib/clock.ts";
import { newId } from "../../../lib/ids.ts";
import { TEST_DIALECT, createMigratedTestDatabase } from "../../../test/test-db.ts";
import type { TestDatabase } from "../../../test/test-db.ts";
import { createTestOpCtx } from "./op-test-harness.ts";
import { historyForgetHandler } from "./history-forget.ts";
import type { WireOp } from "./types.ts";

const NOW = Date.UTC(2026, 8, 24, 10, 0, 0);
const VIDEO_A = "a1B2c3D4e5F";
const VIDEO_B = "abcdefghijk";
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

function wireForget(
  fields: Readonly<{ opId?: string; at: number; videoId: string; eventsBefore: number; resetTotal: boolean }>,
): WireOp {
  return SyncOpEnvelope.parse({
    opId: fields.opId ?? newId(),
    kind: "history.forget",
    at: new Date(fields.at).toISOString(),
    videoId: fields.videoId,
    eventsBefore: new Date(fields.eventsBefore).toISOString(),
    resetTotal: fields.resetTotal,
  });
}

async function applyForget(q: Kysely<Database>, userId: string, fields: Parameters<typeof wireForget>[0]) {
  const head = await lockUser(q, userId);
  const oc = createTestOpCtx({ q, userId, deviceId: DEVICE_ID, head, now: NOW });
  const raw = wireForget(fields);
  const parsed = historyForgetHandler.parse(raw);
  assert.ok(parsed.ok, "history.forget must parse");
  const outcome = await historyForgetHandler.apply(oc, parsed.value, {
    effAt: Math.min(parsed.value.at, oc.now),
    base: null,
  });
  return { raw, outcome, oc };
}

async function seedEvent(q: Kysely<Database>, userId: string, videoId: string, playedAt: number): Promise<void> {
  const head = await lockUser(q, userId);
  await q
    .insertInto("play_events")
    .values({
      user_id: userId,
      event_id: newId(),
      video_id: videoId,
      played_at: playedAt,
      play_time_ms: 6000,
      in_history: 1,
      counts_playtime: 1,
      device_id: DEVICE_ID,
      seq: head.seq + 1,
      received_at: playedAt,
    })
    .execute();
  await q
    .updateTable("sync_heads")
    .set({ seq: head.seq + 1 })
    .where("user_id", "=", userId)
    .execute();
}

async function seedStat(
  q: Kysely<Database>,
  userId: string,
  videoId: string,
  totalMs: number,
  lastPlayedAt: number | null,
): Promise<void> {
  const head = await lockUser(q, userId);
  await q
    .insertInto("play_stats")
    .values({ user_id: userId, video_id: videoId, total_ms: totalMs, last_played_at: lastPlayedAt, seq: head.seq + 1 })
    .execute();
  await q
    .updateTable("sync_heads")
    .set({ seq: head.seq + 1 })
    .where("user_id", "=", userId)
    .execute();
}

async function forgetOf(userId: string, videoId: string) {
  return db.read((q) =>
    q
      .selectFrom("play_forgets")
      .selectAll()
      .where("user_id", "=", userId)
      .where("video_id", "=", videoId)
      .executeTakeFirst(),
  );
}

async function statOf(userId: string, videoId: string) {
  return db.read((q) =>
    q
      .selectFrom("play_stats")
      .selectAll()
      .where("user_id", "=", userId)
      .where("video_id", "=", videoId)
      .executeTakeFirst(),
  );
}

describe(`history.forget (${TEST_DIALECT})`, () => {
  test("resetTotal:false («Убрать из Quick Picks»): deletes the track's history up to the mark, keeps the total", async () => {
    const userId = await makeUser();
    await db.write((q) => seedEvent(q, userId, VIDEO_A, NOW - HOUR_MS));
    await db.write((q) => seedStat(q, userId, VIDEO_A, 50_000, NOW - HOUR_MS));
    const { outcome, oc } = await db.write((q) =>
      applyForget(q, userId, { at: NOW, videoId: VIDEO_A, eventsBefore: NOW, resetTotal: false }),
    );
    assert.deepEqual(outcome, { status: "applied" });
    assert.ok(oc.seq > 0);

    const forget = await forgetOf(userId, VIDEO_A);
    assert.equal(forget?.events_before, NOW);
    assert.equal(forget.total_before, null);
    const events = await db.read((q) =>
      q.selectFrom("play_events").select("event_id").where("user_id", "=", userId).execute(),
    );
    assert.equal(events.length, 0);
    const stat = await statOf(userId, VIDEO_A);
    assert.equal(stat?.total_ms, 50_000, "the total is untouched");
  });

  test("resetTotal:true («Скрыть»): also zeroes the total, with its own seq", async () => {
    const userId = await makeUser();
    await db.write((q) => seedStat(q, userId, VIDEO_A, 70_000, NOW - HOUR_MS));
    await db.write((q) => applyForget(q, userId, { at: NOW, videoId: VIDEO_A, eventsBefore: NOW, resetTotal: true }));
    const forget = await forgetOf(userId, VIDEO_A);
    assert.equal(forget?.events_before, NOW);
    assert.equal(forget.total_before, NOW);
    const stat = await statOf(userId, VIDEO_A);
    assert.equal(stat?.total_ms, 0);
    assert.equal(stat.last_played_at, NOW - HOUR_MS, "last_played_at is not a total, it is left alone");
  });

  test("resetTotal:true with no existing play_stats row: no-op on play_stats, no crash", async () => {
    const userId = await makeUser();
    await db.write((q) => applyForget(q, userId, { at: NOW, videoId: VIDEO_A, eventsBefore: NOW, resetTotal: true }));
    assert.equal(await statOf(userId, VIDEO_A), undefined);
  });

  test("a total already at 0 is not reset again (no extra seq)", async () => {
    const userId = await makeUser();
    await db.write((q) => seedStat(q, userId, VIDEO_A, 0, null));
    await db.write((q) =>
      applyForget(q, userId, { at: NOW - HOUR_MS, videoId: VIDEO_A, eventsBefore: NOW - HOUR_MS, resetTotal: true }),
    );
    const seqAfterFirst = (await statOf(userId, VIDEO_A))?.seq;
    assert.notEqual(seqAfterFirst, undefined);
    // A second reset at a later mark: total_before grows, but play_stats.total_ms is already 0, so it is not rewritten.
    await db.write((q) => applyForget(q, userId, { at: NOW, videoId: VIDEO_A, eventsBefore: NOW, resetTotal: true }));
    const stat = await statOf(userId, VIDEO_A);
    assert.equal(stat?.total_ms, 0);
    assert.equal(stat.seq, seqAfterFirst, "play_stats was not rewritten: it was already 0");
    assert.equal((await forgetOf(userId, VIDEO_A))?.total_before, NOW, "the mark itself still grew");
  });

  test("marks only grow, each independently: a smaller mark changes nothing", async () => {
    const userId = await makeUser();
    await db.write((q) => applyForget(q, userId, { at: NOW, videoId: VIDEO_A, eventsBefore: NOW, resetTotal: true }));
    const { outcome } = await db.write((q) =>
      applyForget(q, userId, { at: NOW, videoId: VIDEO_A, eventsBefore: NOW - HOUR_MS, resetTotal: true }),
    );
    assert.deepEqual(outcome, { status: "applied" }); // no seq: nothing grew
    const forget = await forgetOf(userId, VIDEO_A);
    assert.equal(forget?.events_before, NOW);
    assert.equal(forget.total_before, NOW);
  });

  test("resetTotal:false never raises total_before, even past a larger events mark", async () => {
    const userId = await makeUser();
    await db.write((q) =>
      applyForget(q, userId, { at: NOW, videoId: VIDEO_A, eventsBefore: NOW - 2 * HOUR_MS, resetTotal: true }),
    );
    await db.write((q) => applyForget(q, userId, { at: NOW, videoId: VIDEO_A, eventsBefore: NOW, resetTotal: false }));
    const forget = await forgetOf(userId, VIDEO_A);
    assert.equal(forget?.events_before, NOW, "events_before still grew");
    assert.equal(forget.total_before, NOW - 2 * HOUR_MS, "total_before is untouched by a resetTotal:false call");
  });

  test("only the named track is affected", async () => {
    const userId = await makeUser();
    await db.write((q) => seedEvent(q, userId, VIDEO_A, NOW - MINUTE_MS));
    await db.write((q) => seedEvent(q, userId, VIDEO_B, NOW - MINUTE_MS));
    await db.write((q) => applyForget(q, userId, { at: NOW, videoId: VIDEO_A, eventsBefore: NOW, resetTotal: false }));
    const remaining = await db.read((q) =>
      q.selectFrom("play_events").select("video_id").where("user_id", "=", userId).execute(),
    );
    assert.deepEqual(
      remaining.map((row) => row.video_id),
      [VIDEO_B],
    );
  });

  test("touch adds both the playForgets and playStats keys for the videoId", async () => {
    const userId = await makeUser();
    const { oc, raw } = await db.write((q) =>
      applyForget(q, userId, { at: NOW, videoId: VIDEO_A, eventsBefore: NOW, resetTotal: true }),
    );
    historyForgetHandler.touch(raw, oc.touched);
    assert.deepEqual([...oc.touched.playForgets], [VIDEO_A]);
    assert.deepEqual([...oc.touched.playStats], [VIDEO_A]);
  });
});
