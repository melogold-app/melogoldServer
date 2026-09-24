/**
 * `play.baseline` on the migrated schema, both dialects (DESIGN §3.7, §3.14; API §4.8): `add`/`atLeast`, skipping an
 * entry whose track was reset after the baseline was taken, `superseded` when every entry is skipped, and the
 * `play_stats` quota for brand-new rows.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Kysely } from "kysely";
import { SyncOpEnvelope } from "../../../contract/sync.ts";
import { insertHead, lockUser } from "../../../db/heads.ts";
import type { Database, Db } from "../../../db/index.ts";
import { HOUR_MS } from "../../../lib/clock.ts";
import { newId } from "../../../lib/ids.ts";
import { TEST_DIALECT, createMigratedTestDatabase } from "../../../test/test-db.ts";
import type { TestDatabase } from "../../../test/test-db.ts";
import { createTestOpCtx } from "./op-test-harness.ts";
import { HISTORY_COUNTERS } from "./play-add.ts";
import { playBaselineHandler } from "./play-baseline.ts";
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

function wireBaseline(
  fields: Readonly<{
    opId?: string;
    at: number;
    mode: string;
    entries: readonly Readonly<{ videoId: string; totalMs: number }>[];
  }>,
): WireOp {
  return SyncOpEnvelope.parse({
    opId: fields.opId ?? newId(),
    kind: "play.baseline",
    at: new Date(fields.at).toISOString(),
    mode: fields.mode,
    entries: fields.entries,
  });
}

async function applyBaseline(q: Kysely<Database>, userId: string, fields: Parameters<typeof wireBaseline>[0]) {
  const head = await lockUser(q, userId);
  const oc = createTestOpCtx({ q, userId, deviceId: DEVICE_ID, head, now: NOW });
  const raw = wireBaseline(fields);
  const parsed = playBaselineHandler.parse(raw);
  assert.ok(parsed.ok, "play.baseline must parse");
  const outcome = await playBaselineHandler.apply(oc, parsed.value, {
    effAt: Math.min(parsed.value.at, oc.now),
    base: null,
  });
  return { raw, outcome, oc };
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

describe(`play.baseline (${TEST_DIALECT})`, () => {
  test("mode add: creates a new play_stats row", async () => {
    const userId = await makeUser();
    const { outcome } = await db.write((q) =>
      applyBaseline(q, userId, { at: NOW, mode: "add", entries: [{ videoId: VIDEO_A, totalMs: 1000 }] }),
    );
    assert.equal(outcome.status, "applied");
    const stat = await statOf(userId, VIDEO_A);
    assert.equal(stat?.total_ms, 1000);
    assert.equal(stat.last_played_at, null); // baseline never sets last_played_at
  });

  test("mode add: sums onto an existing total", async () => {
    const userId = await makeUser();
    await db.write((q) =>
      applyBaseline(q, userId, { at: NOW, mode: "add", entries: [{ videoId: VIDEO_A, totalMs: 1000 }] }),
    );
    await db.write((q) =>
      applyBaseline(q, userId, { at: NOW, mode: "add", entries: [{ videoId: VIDEO_A, totalMs: 500 }] }),
    );
    const stat = await statOf(userId, VIDEO_A);
    assert.equal(stat?.total_ms, 1500);
  });

  test("mode atLeast: raises to the larger value and never lowers it", async () => {
    const userId = await makeUser();
    await db.write((q) =>
      applyBaseline(q, userId, { at: NOW, mode: "add", entries: [{ videoId: VIDEO_A, totalMs: 1000 }] }),
    );
    await db.write((q) =>
      applyBaseline(q, userId, { at: NOW, mode: "atLeast", entries: [{ videoId: VIDEO_A, totalMs: 700 }] }),
    );
    assert.equal((await statOf(userId, VIDEO_A))?.total_ms, 1000, "700 < 1000: unchanged");
    await db.write((q) =>
      applyBaseline(q, userId, { at: NOW, mode: "atLeast", entries: [{ videoId: VIDEO_A, totalMs: 1500 }] }),
    );
    assert.equal((await statOf(userId, VIDEO_A))?.total_ms, 1500, "1500 > 1000: raised");
  });

  test("an entry at or after a later total_before reset is skipped; the rest of the batch still applies", async () => {
    const userId = await makeUser();
    await db.write(async (q) => {
      const head = await lockUser(q, userId);
      await q
        .insertInto("play_forgets")
        .values({ user_id: userId, video_id: VIDEO_A, events_before: NOW, total_before: NOW, seq: head.seq + 1 })
        .execute();
      await q
        .updateTable("sync_heads")
        .set({ seq: head.seq + 1 })
        .where("user_id", "=", userId)
        .execute();
    });
    const { outcome } = await db.write((q) =>
      applyBaseline(q, userId, {
        at: NOW - HOUR_MS, // effAt before the reset mark: skipped
        mode: "add",
        entries: [
          { videoId: VIDEO_A, totalMs: 999 },
          { videoId: VIDEO_B, totalMs: 200 },
        ],
      }),
    );
    assert.equal(outcome.status, "applied", "not every entry was skipped");
    assert.equal(await statOf(userId, VIDEO_A), undefined, "the reset track got no row");
    assert.equal((await statOf(userId, VIDEO_B))?.total_ms, 200);
  });

  test("every entry skipped: superseded, nothing written", async () => {
    const userId = await makeUser();
    await db.write(async (q) => {
      const head = await lockUser(q, userId);
      await q
        .insertInto("play_forgets")
        .values({ user_id: userId, video_id: VIDEO_A, events_before: NOW, total_before: NOW, seq: head.seq + 1 })
        .execute();
      await q
        .updateTable("sync_heads")
        .set({ seq: head.seq + 1 })
        .where("user_id", "=", userId)
        .execute();
    });
    const { outcome } = await db.write((q) =>
      applyBaseline(q, userId, { at: NOW - HOUR_MS, mode: "add", entries: [{ videoId: VIDEO_A, totalMs: 999 }] }),
    );
    assert.deepEqual(outcome, { status: "superseded" });
    assert.equal(await statOf(userId, VIDEO_A), undefined);
  });

  test("touch adds every entry's videoId to touched.playStats", async () => {
    const userId = await makeUser();
    const { oc, raw } = await db.write((q) =>
      applyBaseline(q, userId, {
        at: NOW,
        mode: "add",
        entries: [
          { videoId: VIDEO_A, totalMs: 1 },
          { videoId: VIDEO_B, totalMs: 1 },
        ],
      }),
    );
    playBaselineHandler.touch(raw, oc.touched);
    assert.deepEqual(new Set(oc.touched.playStats), new Set([VIDEO_A, VIDEO_B]));
  });

  test("play_stats quota (100000): new rows beyond it are not created, in entry order", async () => {
    const userId = await makeUser();
    const { outcome } = await db.write(async (q) => {
      const head = await lockUser(q, userId);
      const oc = createTestOpCtx({ q, userId, deviceId: DEVICE_ID, head, now: NOW });
      // Simulate being one row short of the fixed 100000 play_stats cap (RequestCounters caches on first read, so
      // the real COUNT(*) never runs; see src/modules/sync/ops/op-test-harness.ts and play-add.int.test.ts).
      await oc.counters.get(HISTORY_COUNTERS.stats, () => Promise.resolve(99_999));
      const raw = wireBaseline({
        at: NOW,
        mode: "add",
        entries: [
          { videoId: VIDEO_A, totalMs: 1 },
          { videoId: VIDEO_B, totalMs: 1 },
        ],
      });
      const parsed = playBaselineHandler.parse(raw);
      assert.ok(parsed.ok);
      const outcome = await playBaselineHandler.apply(oc, parsed.value, { effAt: NOW, base: null });
      return { outcome };
    });
    assert.equal(outcome.status, "applied");
    const rows = await db.read((q) =>
      q.selectFrom("play_stats").select("video_id").where("user_id", "=", userId).execute(),
    );
    assert.equal(rows.length, 1, "only the first entry's row fit the quota");
    assert.equal(rows[0]!.video_id, VIDEO_A);
  });
});
