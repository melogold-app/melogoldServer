/**
 * `play.add` on the migrated schema, both dialects (DESIGN §3.7, §3.11.3, §3.10): history membership, `play_stats`
 * upsert, idempotency through the `play_events` PK, the 2000/hour rate limit and eviction at the caps.
 *
 * Counters that would otherwise need tens of thousands of seed rows (the fixed 60 000 `play_events` cap, the hourly
 * rate limit) are exercised by pre-seeding `oc.counters` with the count a real `COUNT(*)` would have produced: quota
 * counters are loaded once per request and cached (`RequestCounters`, `src/modules/sync/ops/types.ts`), so seeding
 * the cache runs exactly the same `apply` code as a real count would, without the fixture size. The `evictOldest`
 * `DELETE`s themselves still run for real, against real rows. The smaller, env-configurable `HISTORY_MAX_EVENTS` cap
 * is covered separately with a real `COUNT(*)` and no seeding, so the counting query itself is covered honestly too.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Kysely } from "kysely";
import { SYNC_LIMITS } from "../../../contract/limits.ts";
import { SyncOpEnvelope } from "../../../contract/sync.ts";
import type { Database, Db } from "../../../db/index.ts";
import { bumpHead, insertHead, lockUser } from "../../../db/heads.ts";
import { HOUR_MS, MINUTE_MS } from "../../../lib/clock.ts";
import { newId } from "../../../lib/ids.ts";
import { TEST_DIALECT, createMigratedTestDatabase } from "../../../test/test-db.ts";
import type { TestDatabase } from "../../../test/test-db.ts";
import { createTestOpCtx } from "./op-test-harness.ts";
import { HISTORY_COUNTERS, playAddHandler } from "./play-add.ts";
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

const iso = (ms: number): string => new Date(ms).toISOString();

function wireOp(
  fields: Readonly<{
    opId?: string;
    at: number;
    videoId: string;
    playedAt: number;
    playTimeMs: number;
    history: boolean;
    playtime: boolean;
  }>,
): WireOp {
  return SyncOpEnvelope.parse({
    opId: fields.opId ?? newId(),
    kind: "play.add",
    at: iso(fields.at),
    videoId: fields.videoId,
    playedAt: iso(fields.playedAt),
    playTimeMs: fields.playTimeMs,
    history: fields.history,
    playtime: fields.playtime,
  });
}

async function playOnce(
  q: Kysely<Database>,
  userId: string,
  input: Readonly<{
    videoId: string;
    playedAt: number;
    playTimeMs: number;
    history: boolean;
    playtime: boolean;
    opId?: string;
    now?: number;
    historyMaxEvents?: number;
  }>,
) {
  const head = await lockUser(q, userId);
  const oc = createTestOpCtx({
    q,
    userId,
    deviceId: DEVICE_ID,
    head,
    now: input.now ?? NOW,
    historyMaxEvents: input.historyMaxEvents,
  });
  const raw = wireOp({ opId: input.opId, at: input.playedAt, ...input });
  const parsed = playAddHandler.parse(raw);
  assert.ok(parsed.ok, "play.add must parse");
  const outcome = await playAddHandler.apply(oc, parsed.value, {
    effAt: Math.min(parsed.value.at, oc.now),
    base: null,
  });
  return { raw, outcome, oc };
}

describe(`play.add (${TEST_DIALECT})`, () => {
  test("history:true, playtime:true writes an in-history event and a play_stats row", async () => {
    const userId = await makeUser();
    const playedAt = NOW - 5 * MINUTE_MS;
    const { outcome } = await db.write((q) =>
      playOnce(q, userId, { videoId: VIDEO_A, playedAt, playTimeMs: 200_000, history: true, playtime: true }),
    );
    assert.equal(outcome.status, "applied");
    assert.ok(typeof outcome.seq === "number" && outcome.seq > 0);

    const event = await db.read((q) =>
      q.selectFrom("play_events").selectAll().where("user_id", "=", userId).executeTakeFirstOrThrow(),
    );
    assert.equal(event.video_id, VIDEO_A);
    assert.equal(event.played_at, playedAt);
    assert.equal(event.play_time_ms, 200_000);
    assert.equal(event.in_history, 1);
    assert.equal(event.counts_playtime, 1);
    assert.equal(event.device_id, DEVICE_ID);
    assert.notEqual(event.seq, null);

    const stat = await db.read((q) =>
      q
        .selectFrom("play_stats")
        .selectAll()
        .where("user_id", "=", userId)
        .where("video_id", "=", VIDEO_A)
        .executeTakeFirstOrThrow(),
    );
    assert.equal(stat.total_ms, 200_000);
    assert.equal(stat.last_played_at, playedAt);
  });

  test("history:false, playtime:true stores the event with in_history=0 and no seq, but still counts the total", async () => {
    const userId = await makeUser();
    const playedAt = NOW - MINUTE_MS;
    const { outcome } = await db.write((q) =>
      playOnce(q, userId, { videoId: VIDEO_A, playedAt, playTimeMs: 60_000, history: false, playtime: true }),
    );
    assert.equal(outcome.status, "applied");
    // outcome.seq is the play_stats seq (play_events got none): §3.11.2 "hранится 30 дней ради идемпотентности".
    const event = await db.read((q) =>
      q.selectFrom("play_events").selectAll().where("user_id", "=", userId).executeTakeFirstOrThrow(),
    );
    assert.equal(event.in_history, 0);
    assert.equal(event.seq, null);
    const stat = await db.read((q) =>
      q
        .selectFrom("play_stats")
        .selectAll()
        .where("user_id", "=", userId)
        .where("video_id", "=", VIDEO_A)
        .executeTakeFirstOrThrow(),
    );
    assert.equal(stat.total_ms, 60_000);
    assert.equal(stat.last_played_at, null); // never entered the history stream
  });

  test("history:true, playtime:false only moves last_played_at, never the total", async () => {
    const userId = await makeUser();
    const playedAt = NOW - MINUTE_MS;
    await db.write((q) =>
      playOnce(q, userId, { videoId: VIDEO_A, playedAt, playTimeMs: 60_000, history: true, playtime: false }),
    );
    const stat = await db.read((q) =>
      q
        .selectFrom("play_stats")
        .selectAll()
        .where("user_id", "=", userId)
        .where("video_id", "=", VIDEO_A)
        .executeTakeFirstOrThrow(),
    );
    assert.equal(stat.total_ms, 0);
    assert.equal(stat.last_played_at, playedAt);
  });

  test("the server clock clamps a future playedAt (effAt = min(playedAt, now))", async () => {
    const userId = await makeUser();
    const future = NOW + HOUR_MS;
    await db.write((q) =>
      playOnce(q, userId, { videoId: VIDEO_A, playedAt: future, playTimeMs: 1000, history: true, playtime: true }),
    );
    const event = await db.read((q) =>
      q.selectFrom("play_events").selectAll().where("user_id", "=", userId).executeTakeFirstOrThrow(),
    );
    assert.equal(event.played_at, NOW);
  });

  test("a play at or before the '*' forget mark never enters the history, but its time still counts", async () => {
    const userId = await makeUser();
    await db.write(async (q) => {
      const head = await lockUser(q, userId);
      await q
        .insertInto("play_forgets")
        .values({ user_id: userId, video_id: "*", events_before: NOW - HOUR_MS, total_before: null, seq: head.seq + 1 })
        .execute();
      await bumpHead(q, userId, head.seq + 1, NOW);
    });
    const playedAt = NOW - HOUR_MS; // exactly at the mark: inclusive, so still forgotten
    const { outcome } = await db.write((q) =>
      playOnce(q, userId, { videoId: VIDEO_A, playedAt, playTimeMs: 5000, history: true, playtime: true }),
    );
    assert.equal(outcome.status, "applied");
    const event = await db.read((q) =>
      q.selectFrom("play_events").selectAll().where("user_id", "=", userId).executeTakeFirstOrThrow(),
    );
    assert.equal(event.in_history, 0);
    const stat = await db.read((q) =>
      q
        .selectFrom("play_stats")
        .selectAll()
        .where("user_id", "=", userId)
        .where("video_id", "=", VIDEO_A)
        .executeTakeFirstOrThrow(),
    );
    assert.equal(stat.total_ms, 5000, "totals are not touched by history.clear (DESIGN §3.11.5)");
  });

  test("a repeated opId is a no-op: the PK guards play_events, the counters and play_stats do not move again", async () => {
    const userId = await makeUser();
    const opId = newId();
    const playedAt = NOW - MINUTE_MS;
    const first = await db.write((q) =>
      playOnce(q, userId, { opId, videoId: VIDEO_A, playedAt, playTimeMs: 50_000, history: true, playtime: true }),
    );
    assert.equal(first.outcome.status, "applied");
    const second = await db.write((q) =>
      playOnce(q, userId, { opId, videoId: VIDEO_A, playedAt, playTimeMs: 50_000, history: true, playtime: true }),
    );
    assert.deepEqual(second.outcome, { status: "applied" }); // no seq: nothing was written this time
    const rows = await db.read((q) => q.selectFrom("play_events").selectAll().where("user_id", "=", userId).execute());
    assert.equal(rows.length, 1);
    const stat = await db.read((q) =>
      q
        .selectFrom("play_stats")
        .selectAll()
        .where("user_id", "=", userId)
        .where("video_id", "=", VIDEO_A)
        .executeTakeFirstOrThrow(),
    );
    assert.equal(stat.total_ms, 50_000, "the second call must not add playTimeMs again");
  });

  test("touch adds the videoId to touched.playStats, whatever the outcome", async () => {
    const userId = await makeUser();
    const { oc, raw } = await db.write((q) =>
      playOnce(q, userId, { videoId: VIDEO_B, playedAt: NOW, playTimeMs: 1000, history: true, playtime: true }),
    );
    const touched = oc.touched;
    playAddHandler.touch(raw, touched);
    assert.deepEqual([...touched.playStats], [VIDEO_B]);
  });

  describe("rate limit (DESIGN §3.10: 2000 play.add per hour)", () => {
    test("at the limit: deferred op_rate_limited with retryAfterSeconds, nothing written", async () => {
      const userId = await makeUser();
      const opId = newId();
      const boundary = NOW - 45 * MINUTE_MS;
      const { outcome } = await db.write(async (q) => {
        const head = await lockUser(q, userId);
        const oc = createTestOpCtx({ q, userId, deviceId: DEVICE_ID, head, now: NOW });
        await oc.counters.get(HISTORY_COUNTERS.lastHour, () => Promise.resolve(SYNC_LIMITS.playAddPerHour));
        await oc.counters.get(HISTORY_COUNTERS.rateBoundary, () => Promise.resolve(boundary));
        const raw = wireOp({
          opId,
          at: NOW,
          videoId: VIDEO_A,
          playedAt: NOW,
          playTimeMs: 1000,
          history: true,
          playtime: true,
        });
        const parsed = playAddHandler.parse(raw);
        assert.ok(parsed.ok);
        return { outcome: await playAddHandler.apply(oc, parsed.value, { effAt: NOW, base: null }) };
      });
      assert.deepEqual(outcome, { status: "deferred", code: "op_rate_limited", retryAfterSeconds: 15 * 60 });
      const rows = await db.read((q) =>
        q.selectFrom("play_events").selectAll().where("user_id", "=", userId).execute(),
      );
      assert.equal(rows.length, 0);
    });

    test("under the limit: applies normally", async () => {
      const userId = await makeUser();
      const { outcome } = await db.write(async (q) => {
        const head = await lockUser(q, userId);
        const oc = createTestOpCtx({ q, userId, deviceId: DEVICE_ID, head, now: NOW });
        await oc.counters.get(HISTORY_COUNTERS.lastHour, () => Promise.resolve(SYNC_LIMITS.playAddPerHour - 1));
        const raw = wireOp({
          at: NOW,
          videoId: VIDEO_A,
          playedAt: NOW,
          playTimeMs: 1000,
          history: true,
          playtime: true,
        });
        const parsed = playAddHandler.parse(raw);
        assert.ok(parsed.ok);
        return { outcome: await playAddHandler.apply(oc, parsed.value, { effAt: NOW, base: null }) };
      });
      assert.equal(outcome.status, "applied");
    });
  });

  describe("eviction at the caps (DESIGN §3.10, §3.11.6)", () => {
    test("HISTORY_MAX_EVENTS (env-configurable): the oldest in-history rows go first", async () => {
      const userId = await makeUser();
      const cap = 3;
      for (let i = 0; i < cap; i++) {
        await db.write((q) =>
          playOnce(q, userId, {
            videoId: VIDEO_A,
            playedAt: NOW - (cap - i) * HOUR_MS,
            playTimeMs: 1000,
            history: true,
            playtime: true,
            historyMaxEvents: cap,
          }),
        );
      }
      const before = await db.read((q) =>
        q
          .selectFrom("play_events")
          .select((eb) => eb.fn.countAll().as("n"))
          .where("user_id", "=", userId)
          .where("in_history", "=", 1)
          .executeTakeFirstOrThrow(),
      );
      assert.equal(Number(before.n), cap);

      await db.write((q) =>
        playOnce(q, userId, {
          videoId: VIDEO_B,
          playedAt: NOW,
          playTimeMs: 1000,
          history: true,
          playtime: true,
          historyMaxEvents: cap,
        }),
      );

      const rows = await db.read((q) =>
        q
          .selectFrom("play_events")
          .select(["video_id", "played_at"])
          .where("user_id", "=", userId)
          .where("in_history", "=", 1)
          .orderBy("played_at")
          .execute(),
      );
      assert.equal(rows.length, cap, "the cap is not exceeded");
      assert.ok(
        rows.every((row) => row.played_at > NOW - cap * HOUR_MS),
        "the oldest in-history row (played first) was evicted",
      );
      assert.equal(rows.at(-1)?.video_id, VIDEO_B, "the newest play is the one that was just added");
    });

    test("the fixed 60000 play_events cap: idle (in_history=0) rows are evicted before in-history ones", async () => {
      const userId = await makeUser();
      // Two idle rows and one in-history row, all real: the DELETEs below must remove exactly these three, in order.
      await db.write(async (q) => {
        const head = await lockUser(q, userId);
        await q
          .insertInto("play_events")
          .values([
            {
              user_id: userId,
              event_id: newId(),
              video_id: VIDEO_A,
              played_at: NOW - 3 * HOUR_MS,
              play_time_ms: 1000,
              in_history: 0,
              counts_playtime: 1,
              device_id: DEVICE_ID,
              seq: null,
              received_at: NOW - 3 * HOUR_MS,
            },
            {
              user_id: userId,
              event_id: newId(),
              video_id: VIDEO_A,
              played_at: NOW - 2 * HOUR_MS,
              play_time_ms: 1000,
              in_history: 0,
              counts_playtime: 1,
              device_id: DEVICE_ID,
              seq: null,
              received_at: NOW - 2 * HOUR_MS,
            },
            {
              user_id: userId,
              event_id: newId(),
              video_id: VIDEO_A,
              played_at: NOW - HOUR_MS,
              play_time_ms: 1000,
              in_history: 1,
              counts_playtime: 1,
              device_id: DEVICE_ID,
              seq: head.seq + 1,
              received_at: NOW - HOUR_MS,
            },
          ])
          .execute();
        await bumpHead(q, userId, head.seq + 1, NOW);
      });

      await db.write(async (q) => {
        const head = await lockUser(q, userId);
        const oc = createTestOpCtx({ q, userId, deviceId: DEVICE_ID, head, now: NOW });
        // Simulate a user already at the fixed 60000-row cap without inserting 60000 rows: the counter is cached on
        // first read, so `makeRoomForEvent`'s own COUNT(*) never runs (see the module comment above).
        await oc.counters.get(HISTORY_COUNTERS.events, () => Promise.resolve(SYNC_LIMITS.maxPlayEvents));
        const raw = wireOp({
          at: NOW,
          videoId: VIDEO_B,
          playedAt: NOW,
          playTimeMs: 1000,
          history: true,
          playtime: true,
        });
        const parsed = playAddHandler.parse(raw);
        assert.ok(parsed.ok);
        const outcome = await playAddHandler.apply(oc, parsed.value, { effAt: NOW, base: null });
        assert.equal(outcome.status, "applied");
      });

      const rows = await db.read((q) =>
        q.selectFrom("play_events").select(["video_id", "in_history"]).where("user_id", "=", userId).execute(),
      );
      assert.equal(rows.length, 1, "the three seeded rows were evicted, only the new play remains");
      assert.equal(rows[0]!.video_id, VIDEO_B);
      assert.equal(rows[0]!.in_history, 1);
    });
  });
});
