/**
 * `spec/sync-scenarios/history.json` end to end, both dialects: each scenario's steps run through
 * {@link runHistoryOp} (DESIGN §3.8's `applyOp`, restricted to the four kinds T2.3 owns; see
 * `src/modules/sync/ops/op-test-harness.ts` for why `sync.service.ts`, T2.1, is not used here), and the final
 * history stream (`plays`, `playStats`, `playForgets`) is compared against `expect` as sets.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Kysely } from "kysely";
import { bumpHead, insertHead, lockUser } from "../../../db/heads.ts";
import type { Database, Db } from "../../../db/index.ts";
import { SyncOpEnvelope } from "../../../contract/sync.ts";
import { newId } from "../../../lib/ids.ts";
import { parseIso } from "../../../lib/time.ts";
import { TEST_DIALECT, createMigratedTestDatabase } from "../../../test/test-db.ts";
import type { TestDatabase } from "../../../test/test-db.ts";
import { buildOpHandlers } from "./index.ts";
import { createTestOpCtx, runHistoryOp } from "./op-test-harness.ts";
import { historyClearHandler } from "./history-clear.ts";
import { historyForgetHandler } from "./history-forget.ts";
import { playAddHandler } from "./play-add.ts";
import { playBaselineHandler } from "./play-baseline.ts";

const HANDLERS = buildOpHandlers({
  "play.add": playAddHandler,
  "play.baseline": playBaselineHandler,
  "history.clear": historyClearHandler,
  "history.forget": historyForgetHandler,
});

const SCENARIOS_PATH = fileURLToPath(new URL("../../../../spec/sync-scenarios/history.json", import.meta.url));

type ScenarioOp = Readonly<{ opId: string; kind: string; at: string }> & Record<string, unknown>;
type ExpectedResult = Readonly<{ status: string; code: string | null; replayed: boolean }>;
type Step = Readonly<{ now: string; device: string; ops: readonly ScenarioOp[]; results: readonly ExpectedResult[] }>;
type ExpectedPlay = Readonly<{
  eventId: string;
  videoId: string;
  playedAt: string;
  playTimeMs: number;
  device: string;
}>;
type ExpectedStat = Readonly<{ videoId: string; totalPlayTimeMs: number; lastPlayedAt: string | null }>;
type ExpectedForget = Readonly<{ videoId: string; eventsBefore: string; totalBefore: string | null }>;
type Scenario = Readonly<{
  name: string;
  devices: readonly string[];
  steps: readonly Step[];
  expect: Readonly<{
    plays: readonly ExpectedPlay[];
    playStats: readonly ExpectedStat[];
    playForgets: readonly ExpectedForget[];
  }>;
}>;
type ScenarioFile = Readonly<{ scenarios: readonly Scenario[] }>;

const { scenarios } = JSON.parse(readFileSync(SCENARIOS_PATH, "utf8")) as ScenarioFile;

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
      password_changed_at: 0,
      recovery_code_hash: "0".repeat(64),
      recovery_code_created_at: 0,
      created_at: 0,
      updated_at: 0,
    })
    .execute();
}

/** Runs one step's ops in a single `db.write` (one request), bumping the head as the real runner would. */
async function runStep(userId: string, deviceId: string, step: Step): Promise<ExpectedResult[]> {
  return db.write(async (q) => {
    const head = await lockUser(q, userId);
    const now = parseIso(step.now);
    if (now === null) throw new Error(`bad "now" in fixture: ${step.now}`);
    const oc = createTestOpCtx({ q, userId, deviceId, head, now });
    const results: ExpectedResult[] = [];
    for (const op of step.ops) {
      // The route's own validator (DESIGN §3.9): opId/kind/at/base, nothing else. `at` becomes epoch ms.
      const raw = SyncOpEnvelope.parse(op);
      const result = await runHistoryOp(oc, HANDLERS, raw);
      results.push({ status: result.status, code: result.code, replayed: result.replayed });
    }
    if (oc.seq > head.seq) await bumpHead(q, userId, oc.seq, now);
    return results;
  });
}

async function finalHistory(userId: string, deviceIdToName: ReadonlyMap<string, string>) {
  const plays = await db.read((q) =>
    q
      .selectFrom("play_events")
      .select(["event_id", "video_id", "played_at", "play_time_ms", "device_id"])
      .where("user_id", "=", userId)
      .where("in_history", "=", 1)
      .execute(),
  );
  const playStats = await db.read((q) =>
    q
      .selectFrom("play_stats")
      .select(["video_id", "total_ms", "last_played_at"])
      .where("user_id", "=", userId)
      .execute(),
  );
  const playForgets = await db.read((q) =>
    q
      .selectFrom("play_forgets")
      .select(["video_id", "events_before", "total_before"])
      .where("user_id", "=", userId)
      .execute(),
  );
  return {
    plays: plays
      .map((row) => ({
        eventId: row.event_id,
        videoId: row.video_id,
        playedAt: row.played_at,
        playTimeMs: row.play_time_ms,
        device: row.device_id === null ? null : (deviceIdToName.get(row.device_id) ?? row.device_id),
      }))
      .sort((a, b) => a.eventId.localeCompare(b.eventId)),
    playStats: playStats
      .map((row) => ({ videoId: row.video_id, totalPlayTimeMs: row.total_ms, lastPlayedAt: row.last_played_at }))
      .sort((a, b) => a.videoId.localeCompare(b.videoId)),
    playForgets: playForgets
      .map((row) => ({ videoId: row.video_id, eventsBefore: row.events_before, totalBefore: row.total_before }))
      .sort((a, b) => a.videoId.localeCompare(b.videoId)),
  };
}

function isoOrThrow(text: string): number {
  const value = parseIso(text);
  if (value === null) throw new Error(`bad Iso in fixture: ${text}`);
  return value;
}

describe(`history scenarios (${TEST_DIALECT}, spec/sync-scenarios/history.json)`, () => {
  for (const scenario of scenarios) {
    test(scenario.name, async () => {
      const userId = newId();
      await db.write(async (q) => {
        await insertUser(q, userId);
        await insertHead(q, userId, 0);
      });
      const deviceIds = new Map(scenario.devices.map((name) => [name, newId()]));
      const deviceIdToName = new Map([...deviceIds].map(([name, id]) => [id, name]));

      for (const step of scenario.steps) {
        const deviceId = deviceIds.get(step.device);
        assert.ok(deviceId, `unknown device "${step.device}" in scenario "${scenario.name}"`);
        const results = await runStep(userId, deviceId, step);
        assert.deepEqual(results, step.results, `${scenario.name}: step at ${step.now}`);
      }

      const actual = await finalHistory(userId, deviceIdToName);
      const expectedPlays = [...scenario.expect.plays]
        .map((play) => ({
          eventId: play.eventId,
          videoId: play.videoId,
          playedAt: isoOrThrow(play.playedAt),
          playTimeMs: play.playTimeMs,
          device: play.device,
        }))
        .sort((a, b) => a.eventId.localeCompare(b.eventId));
      const expectedStats = [...scenario.expect.playStats]
        .map((stat) => ({
          videoId: stat.videoId,
          totalPlayTimeMs: stat.totalPlayTimeMs,
          lastPlayedAt: stat.lastPlayedAt === null ? null : isoOrThrow(stat.lastPlayedAt),
        }))
        .sort((a, b) => a.videoId.localeCompare(b.videoId));
      const expectedForgets = [...scenario.expect.playForgets]
        .map((forget) => ({
          videoId: forget.videoId,
          eventsBefore: isoOrThrow(forget.eventsBefore),
          totalBefore: forget.totalBefore === null ? null : isoOrThrow(forget.totalBefore),
        }))
        .sort((a, b) => a.videoId.localeCompare(b.videoId));

      assert.deepEqual(actual.plays, expectedPlays, `${scenario.name}: plays`);
      assert.deepEqual(actual.playStats, expectedStats, `${scenario.name}: playStats`);
      assert.deepEqual(actual.playForgets, expectedForgets, `${scenario.name}: playForgets`);
    });
  }
});
