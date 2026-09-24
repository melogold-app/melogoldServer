/**
 * `spec/sync-scenarios/playlists.json` (PLAN T2.2 acceptance "playlists.int"): every scenario replayed directly
 * through the `OpCtx` factory (`../ops/test-support.ts`), one op per step, checking each step's `OpResult` status and
 * every named playlist's final present items. Plus a few handler behaviours the scenario format cannot express
 * cleanly: idempotent `playlist.create`, the recovery chain and the 48-character rebalance.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { fromDbBool } from "../../../db/codecs.ts";
import { readHead } from "../../../db/heads.ts";
import type { Db } from "../../../db/index.ts";
import { createDevice, createUser } from "../../../test/factories.ts";
import type { TestDevice, TestUser } from "../../../test/factories.ts";
import { createMigratedTestDatabase } from "../../../test/test-db.ts";
import type { MigratedTestDatabase } from "../../../test/test-db.ts";
import { playlistCreate } from "../ops/playlist-create.ts";
import { playlistDelete } from "../ops/playlist-delete.ts";
import { playlistImport } from "../ops/playlist-import.ts";
import { playlistItemMove } from "../ops/playlist-item-move.ts";
import { playlistItemRemove } from "../ops/playlist-item-remove.ts";
import { playlistItemsAdd } from "../ops/playlist-items-add.ts";
import { playlistItemsReplace } from "../ops/playlist-items-replace.ts";
import { playlistUpdate } from "../ops/playlist-update.ts";
import { applyRawOp, withOpCtx } from "../ops/test-support.ts";
import type { OpHandler, WireOp } from "../ops/types.ts";
import { recoveryPlaylistId } from "../../../lib/ids.ts";
import { findRecoveryTarget } from "./recovery.ts";
import { keyBetween, tryKeysBetween } from "./sort-keys.ts";

const HANDLERS: Readonly<Record<string, OpHandler>> = {
  "playlist.create": playlistCreate,
  "playlist.update": playlistUpdate,
  "playlist.delete": playlistDelete,
  "playlist.items.add": playlistItemsAdd,
  "playlist.item.remove": playlistItemRemove,
  "playlist.item.move": playlistItemMove,
  "playlist.items.replace": playlistItemsReplace,
  "playlist.import": playlistImport,
};

type ScenarioStep = Readonly<{
  opId: string;
  device: string;
  kind: string;
  at: number;
  base: string;
  fields: Readonly<Record<string, unknown>>;
  expectStatus: string;
  expectCode?: string;
  expectRedirectTo?: string;
}>;

type Scenario = Readonly<{
  name: string;
  playlistId: string;
  recoveryPlaylistId?: string;
  steps: readonly ScenarioStep[];
  expectFinal: Readonly<Record<string, Readonly<{ deleted: boolean; items: readonly string[] }>>>;
}>;

const scenarios = (
  JSON.parse(readFileSync(new URL("../../../../spec/sync-scenarios/playlists.json", import.meta.url), "utf8")) as {
    license: string;
    scenarios: Scenario[];
  }
).scenarios;

/** Resolves a step's symbolic `base` ("none", or "afterStep:<index>") against the head seq recorded after each step. */
function resolveBase(base: string, epoch: string, headSeqAfterStep: readonly number[]): string | undefined {
  if (base === "none") return undefined;
  const match = /^afterStep:(\d+)$/.exec(base);
  if (!match?.[1]) throw new Error(`bad scenario base: "${base}"`);
  const seq = headSeqAfterStep[Number(match[1])];
  if (seq === undefined) throw new Error(`scenario base refers to a step that has not run yet: "${base}"`);
  return `${epoch}.${seq}.${seq}`;
}

async function runScenario(db: Db, scenario: Scenario): Promise<void> {
  const user = await createUser(db);
  const devices = new Map<string, TestDevice>();
  const headSeqAfterStep: number[] = [];

  for (const step of scenario.steps) {
    let device = devices.get(step.device);
    if (device === undefined) {
      device = await createDevice(db, user.id, { name: step.device });
      devices.set(step.device, device);
    }
    const handler = HANDLERS[step.kind];
    if (handler === undefined) throw new Error(`no handler registered for kind "${step.kind}"`);
    const base = resolveBase(step.base, user.epoch, headSeqAfterStep);
    const raw = { opId: step.opId, kind: step.kind, at: step.at, base, ...step.fields } as WireOp;
    const outcome = await withOpCtx(db, { userId: user.id, deviceId: device.id, now: step.at }, (oc) =>
      applyRawOp(oc, handler, raw),
    );
    const label = `${scenario.name} / ${step.kind} (${step.opId})`;
    assert.equal(outcome.status, step.expectStatus, label);
    if (step.expectCode !== undefined) {
      assert.equal("code" in outcome ? outcome.code : undefined, step.expectCode, label);
    }
    if (step.expectRedirectTo !== undefined) {
      assert.equal(outcome.status === "redirected" ? outcome.playlistId : undefined, step.expectRedirectTo, label);
    }
    const head = await db.read((q) => readHead(q, user.id));
    headSeqAfterStep.push(head.seq);
  }

  for (const [playlistId, expected] of Object.entries(scenario.expectFinal)) {
    const row = await db.read((q) =>
      q
        .selectFrom("sync_playlists")
        .selectAll()
        .where("user_id", "=", user.id)
        .where("id", "=", playlistId)
        .executeTakeFirst(),
    );
    assert.ok(row, `${scenario.name}: playlist ${playlistId} does not exist`);
    assert.equal(fromDbBool(row.deleted), expected.deleted, `${scenario.name}: playlist ${playlistId} deleted`);
    const items = await db.read((q) =>
      q
        .selectFrom("sync_playlist_items")
        .selectAll()
        .where("user_id", "=", user.id)
        .where("playlist_id", "=", playlistId)
        .where("present", "=", 1)
        .orderBy("sort_key")
        .orderBy("video_id")
        .execute(),
    );
    assert.deepEqual(
      items.map((item) => item.video_id),
      expected.items,
      `${scenario.name}: playlist ${playlistId} items`,
    );
  }
}

describe("spec/sync-scenarios/playlists.json", () => {
  let database: MigratedTestDatabase;
  before(async () => {
    database = await createMigratedTestDatabase();
  });
  after(async () => {
    await database.db.destroy();
    await database.database.cleanup();
  });

  for (const scenario of scenarios) {
    test(scenario.name, () => runScenario(database.db, scenario));
  }
});

describe("playlist handlers: behaviour the scenario format does not cover", () => {
  let database: MigratedTestDatabase;
  let user: TestUser;
  let deviceA: TestDevice;
  before(async () => {
    database = await createMigratedTestDatabase();
    user = await createUser(database.db);
    deviceA = await createDevice(database.db, user.id, { name: "A" });
  });
  after(async () => {
    await database.db.destroy();
    await database.database.cleanup();
  });

  const op = (kind: string, at: number, fields: Record<string, unknown>): WireOp => ({
    opId: crypto.randomUUID(),
    kind,
    at,
    base: undefined,
    ...fields,
  });

  const apply = (deviceId: string, now: number, kind: string, fields: Record<string, unknown>) => {
    const handler = HANDLERS[kind];
    if (handler === undefined) throw new Error(`no handler for ${kind}`);
    return withOpCtx(database.db, { userId: user.id, deviceId, now }, (oc) =>
      applyRawOp(oc, handler, op(kind, now, fields)),
    );
  };

  test("playlist.create is a no-op (applied, no seq spent) when the playlist already exists and is live", async () => {
    const playlistId = crypto.randomUUID();
    const first = await apply(deviceA.id, 1000, "playlist.create", {
      playlistId,
      name: "Once",
      videoIds: ["cccccccccc1"],
    });
    assert.equal(first.status, "applied");
    const headBefore = await database.db.read((q) => readHead(q, user.id));
    const second = await apply(deviceA.id, 2000, "playlist.create", {
      playlistId,
      name: "Once again",
      videoIds: ["cccccccccc2"],
    });
    assert.equal(second.status, "applied");
    const headAfter = await database.db.read((q) => readHead(q, user.id));
    assert.equal(headAfter.seq, headBefore.seq, "a no-op must not spend a seq");
    const row = await database.db.read((q) =>
      q
        .selectFrom("sync_playlists")
        .selectAll()
        .where("user_id", "=", user.id)
        .where("id", "=", playlistId)
        .executeTakeFirstOrThrow(),
    );
    assert.equal(row.name, "Once", "the second create must not overwrite the header");
  });

  test("the recovery chain follows uuidv5 links: a deleted recovery playlist hands off to the next one", async () => {
    const playlistId = crypto.randomUUID();
    await apply(deviceA.id, 1000, "playlist.create", { playlistId, name: "Chain", videoIds: [] });
    await apply(deviceA.id, 2000, "playlist.delete", { playlistId });

    const firstRecoveryId = recoveryPlaylistId(playlistId);
    const redirectedOnce = await apply(deviceA.id, 1500, "playlist.items.add", {
      playlistId,
      videoIds: ["dddddddddd1"],
    });
    assert.equal(redirectedOnce.status, "redirected");
    assert.equal(redirectedOnce.playlistId, firstRecoveryId);

    await apply(deviceA.id, 3000, "playlist.delete", { playlistId: firstRecoveryId });
    const secondRecoveryId = recoveryPlaylistId(firstRecoveryId);
    const redirectedTwice = await apply(deviceA.id, 1600, "playlist.items.add", {
      playlistId,
      videoIds: ["dddddddddd2"],
    });
    assert.equal(redirectedTwice.status, "redirected");
    assert.equal(redirectedTwice.playlistId, secondRecoveryId);

    const target = await withOpCtx(database.db, { userId: user.id, deviceId: deviceA.id, now: 4000 }, (oc) =>
      findRecoveryTarget(oc, {
        id: playlistId,
        name: "x",
        browseId: null,
        thumbnailUrl: null,
        createdAt: 0,
        deleted: true,
        deletedSeq: 1,
        itemCount: 0,
        header: { seq: 0, at: 0, dev: null },
      }),
    );
    assert.equal(target.id, secondRecoveryId);
  });

  test("a key that would grow past 48 characters rebalances the whole playlist with fresh keys and seqs", async () => {
    const playlistId = crypto.randomUUID();
    // Bisect between "a0" and "a1" until nothing fits between the two remaining neighbours within 48 characters
    // (`sort-keys.ts`'s own documented growth: about one character every six insertions at the same place).
    let lower = "a0";
    const upper = "a1";
    while (tryKeysBetween(lower, upper, 1) !== null) lower = keyBetween(lower, upper);
    assert.equal(tryKeysBetween(lower, upper, 1), null, "test setup: the gap must not fit a key within 48 characters");

    await database.db.write(async (q) => {
      await q
        .insertInto("sync_playlists")
        .values({
          user_id: user.id,
          id: playlistId,
          name: "Tight keys",
          browse_id: null,
          thumbnail_url: null,
          created_at: 1000,
          deleted: 0,
          deleted_at: null,
          deleted_seq: null,
          item_count: 2,
          seq: 1,
          clk_at: 1000,
          clk_dev: deviceA.id,
        })
        .execute();
      await q
        .insertInto("sync_playlist_items")
        .values([
          {
            user_id: user.id,
            playlist_id: playlistId,
            video_id: "eeeeeeeeee1",
            present: 1,
            sort_key: lower,
            added_at: 1000,
            seq: 1,
            mem_seq: 1,
            mem_at: 1000,
            mem_dev: deviceA.id,
            pos_seq: 1,
            pos_at: 1000,
            pos_dev: deviceA.id,
          },
          {
            user_id: user.id,
            playlist_id: playlistId,
            video_id: "eeeeeeeeee2",
            present: 1,
            sort_key: upper,
            added_at: 1000,
            seq: 1,
            mem_seq: 1,
            mem_at: 1000,
            mem_dev: deviceA.id,
            pos_seq: 1,
            pos_at: 1000,
            pos_dev: deviceA.id,
          },
        ])
        .execute();
      await q.updateTable("sync_heads").set({ seq: 1 }).where("user_id", "=", user.id).execute();
    });

    const outcome = await apply(deviceA.id, 2000, "playlist.items.add", {
      playlistId,
      videoIds: ["eeeeeeeeee3"],
      after: "eeeeeeeeee1",
      before: "eeeeeeeeee2",
    });
    assert.equal(outcome.status, "applied");

    const items = await database.db.read((q) =>
      q
        .selectFrom("sync_playlist_items")
        .selectAll()
        .where("user_id", "=", user.id)
        .where("playlist_id", "=", playlistId)
        .orderBy("sort_key")
        .execute(),
    );
    assert.deepEqual(
      items.map((item) => item.video_id),
      ["eeeeeeeeee1", "eeeeeeeeee3", "eeeeeeeeee2"],
      "the rebalance must keep the requested order",
    );
    for (const item of items) assert.ok(item.sort_key.length <= 48, `rebalanced key too long: ${item.sort_key}`);
    // The rebalance reissues every present item's key, so the two untouched items get fresh keys and seqs too
    // (max(mem_seq, pos_seq), DESIGN §3.7).
    const first = items.find((item) => item.video_id === "eeeeeeeeee1");
    const second = items.find((item) => item.video_id === "eeeeeeeeee2");
    assert.notEqual(first?.sort_key, lower);
    assert.notEqual(second?.sort_key, upper);
    assert.ok((first?.pos_seq ?? 0) > 1);
    assert.ok((second?.pos_seq ?? 0) > 1);
  });
});
