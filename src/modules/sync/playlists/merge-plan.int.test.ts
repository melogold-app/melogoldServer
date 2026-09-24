/**
 * `POST /sync/merge-plan` (API §4.7, DESIGN §3.14, PLAN T2.2 acceptance "merge-plan.int"): the five rules of
 * `computeMergePlan`, in the order they apply, each server playlist claimed at most once; then one check that
 * {@link planMerge} reads real rows the same way.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { MergePlanInput } from "../../../contract/sync.ts";
import { createUser } from "../../../test/factories.ts";
import { createMigratedTestDatabase } from "../../../test/test-db.ts";
import type { MigratedTestDatabase } from "../../../test/test-db.ts";
import { computeMergePlan, normalizePlaylistName, planMerge } from "./merge-plan.ts";
import type { ServerPlaylistSummary } from "./merge-plan.ts";

const LIVE_A: ServerPlaylistSummary = {
  id: "a0000000-0000-4000-8000-000000000001",
  name: "Rock",
  browseId: "VLPLa",
  deleted: false,
};
const LIVE_B: ServerPlaylistSummary = {
  id: "a0000000-0000-4000-8000-000000000002",
  name: "Jazz",
  browseId: "VLPLb",
  deleted: false,
};
const DELETED: ServerPlaylistSummary = {
  id: "a0000000-0000-4000-8000-000000000003",
  name: "Old",
  browseId: null,
  deleted: true,
};

/** `MergePlanInput` fills in `syncId`/`browseId` as `undefined` (the contract's `optional()` keeps the key). */
function local(
  input: Readonly<{ localKey: string; name: string; syncId?: string; browseId?: string }>,
): MergePlanInput {
  return { localKey: input.localKey, name: input.name, syncId: input.syncId, browseId: input.browseId };
}

describe("computeMergePlan", () => {
  test("rule 1: a live syncId merges and claims its server playlist", () => {
    const plan = computeMergePlan([LIVE_A, LIVE_B], {
      playlists: [local({ localKey: "1", syncId: LIVE_A.id, name: "whatever" })],
    });
    assert.deepEqual(plan.plan, [{ localKey: "1", action: "merge", playlistId: LIVE_A.id, serverName: "Rock" }]);
  });

  test("rule 2: a deleted syncId answers deleted and claims nothing (two locals may share one tombstone)", () => {
    const plan = computeMergePlan([DELETED], {
      playlists: [
        local({ localKey: "1", syncId: DELETED.id, name: "x" }),
        local({ localKey: "2", syncId: DELETED.id, name: "y" }),
      ],
    });
    assert.deepEqual(plan.plan, [
      { localKey: "1", action: "deleted", playlistId: DELETED.id, serverName: null },
      { localKey: "2", action: "deleted", playlistId: DELETED.id, serverName: null },
    ]);
  });

  test("rule 3: browseId merges only when exactly one live free server and one unresolved local share it", () => {
    const oneToOne = computeMergePlan([LIVE_A], {
      playlists: [local({ localKey: "1", name: "anything", browseId: "VLPLa" })],
    });
    assert.equal(oneToOne.plan[0]?.action, "merge");
    assert.equal(oneToOne.plan[0].playlistId, LIVE_A.id);

    // Two locals share the same browseId: neither is "the only one", so rule 3 matches neither.
    const ambiguousLocal = computeMergePlan([LIVE_A], {
      playlists: [
        local({ localKey: "1", name: "x", browseId: "VLPLa" }),
        local({ localKey: "2", name: "y", browseId: "VLPLa" }),
      ],
    });
    assert.ok(ambiguousLocal.plan.every((entry) => entry.action === "create"));

    // Two server playlists share the browseId: not "the only one" server-side either.
    const twin: ServerPlaylistSummary = { ...LIVE_B, browseId: "VLPLa" };
    const ambiguousServer = computeMergePlan([LIVE_A, twin], {
      playlists: [local({ localKey: "1", name: "x", browseId: "VLPLa" })],
    });
    assert.equal(ambiguousServer.plan[0]?.action, "create");
  });

  test("rule 4: name match runs only over what rule 3 left, normalized (NFKC, whitespace, case)", () => {
    const plan = computeMergePlan([LIVE_A], { playlists: [local({ localKey: "1", name: "  ROCK   " })] });
    assert.deepEqual(plan.plan, [{ localKey: "1", action: "merge", playlistId: LIVE_A.id, serverName: "Rock" }]);

    // A browseId match already claimed the only server playlist with this name: rule 4 has nothing left to give.
    const claimedByBrowse = computeMergePlan([LIVE_A], {
      playlists: [local({ localKey: "1", name: "Rock", browseId: "VLPLa" }), local({ localKey: "2", name: "rock" })],
    });
    assert.equal(claimedByBrowse.plan.find((e) => e.localKey === "1")?.action, "merge");
    assert.equal(claimedByBrowse.plan.find((e) => e.localKey === "2")?.action, "create");
  });

  test("rule 5: create reuses an unknown syncId, mints a fresh one otherwise", () => {
    const freshId = "b0000000-0000-4000-8000-000000000099";
    const unknown = computeMergePlan([], { playlists: [local({ localKey: "1", syncId: freshId, name: "New" })] });
    assert.deepEqual(unknown.plan, [{ localKey: "1", action: "create", playlistId: freshId, serverName: null }]);

    const noSyncId = computeMergePlan([], { playlists: [local({ localKey: "1", name: "New" })] });
    assert.equal(noSyncId.plan[0]?.action, "create");
    assert.notEqual(noSyncId.plan[0].playlistId, undefined);

    // The syncId is known (claimed by an earlier local via rule 1): a second local with the same id never reuses it.
    const collision = computeMergePlan([LIVE_A], {
      playlists: [
        local({ localKey: "1", syncId: LIVE_A.id, name: "x" }),
        local({ localKey: "2", syncId: LIVE_A.id, name: "y" }),
      ],
    });
    const first = collision.plan.find((e) => e.localKey === "1");
    const second = collision.plan.find((e) => e.localKey === "2");
    assert.equal(first?.action, "merge");
    assert.equal(second?.action, "create");
    assert.notEqual(second.playlistId, LIVE_A.id);
  });

  test("every server playlist is used by at most one entry, across all five passes", () => {
    const plan = computeMergePlan([LIVE_A, LIVE_B, DELETED], {
      playlists: [
        local({ localKey: "1", syncId: LIVE_A.id, name: "Rock" }),
        local({ localKey: "2", name: "rock" }), // would also match LIVE_A by name, but it is already claimed
        local({ localKey: "3", name: "x", browseId: "VLPLb" }),
        local({ localKey: "4", syncId: DELETED.id, name: "z" }),
      ],
    });
    const claimedIds = plan.plan.filter((e) => e.action === "merge").map((e) => e.playlistId);
    assert.deepEqual(new Set(claimedIds).size, claimedIds.length);
    assert.deepEqual(
      plan.plan.map((e) => e.action),
      ["merge", "create", "merge", "deleted"],
    );
  });

  test("plan follows the request's order, one entry per localKey", () => {
    const plan = computeMergePlan([LIVE_A], {
      playlists: [local({ localKey: "z", name: "a" }), local({ localKey: "a", name: "b" })],
    });
    assert.deepEqual(
      plan.plan.map((e) => e.localKey),
      ["z", "a"],
    );
  });

  test("normalizePlaylistName: NFKC, trim, collapse whitespace, lower-case", () => {
    assert.equal(normalizePlaylistName("  Rock   n   Roll  "), "rock n roll");
    assert.equal(normalizePlaylistName("Café"), normalizePlaylistName("Café"));
  });
});

describe("planMerge (reads real rows)", () => {
  let database: MigratedTestDatabase;
  before(async () => {
    database = await createMigratedTestDatabase();
  });
  after(async () => {
    await database.db.destroy();
    await database.database.cleanup();
  });

  test("live and deleted playlists of the user feed the same five rules", async () => {
    const user = await createUser(database.db);
    const other = await createUser(database.db);
    await database.db.write((q) =>
      q
        .insertInto("sync_playlists")
        .values([
          {
            user_id: user.id,
            id: LIVE_A.id,
            name: LIVE_A.name,
            browse_id: LIVE_A.browseId,
            thumbnail_url: null,
            created_at: 1000,
            deleted: 0,
            deleted_at: null,
            deleted_seq: null,
            item_count: 0,
            seq: 1,
            clk_at: 1000,
            clk_dev: null,
          },
          {
            user_id: user.id,
            id: DELETED.id,
            name: DELETED.name,
            browse_id: null,
            thumbnail_url: null,
            created_at: 1000,
            deleted: 1,
            deleted_at: 2000,
            deleted_seq: 2,
            item_count: 0,
            seq: 2,
            clk_at: 1000,
            clk_dev: null,
          },
          // Another user's playlist, same name: must never be visible to this plan.
          {
            user_id: other.id,
            id: "a0000000-0000-4000-8000-000000000009",
            name: "Rock",
            browse_id: null,
            thumbnail_url: null,
            created_at: 1000,
            deleted: 0,
            deleted_at: null,
            deleted_seq: null,
            item_count: 0,
            seq: 1,
            clk_at: 1000,
            clk_dev: null,
          },
        ])
        .execute(),
    );
    const plan = await database.db.read((q) =>
      planMerge(q, user.id, {
        playlists: [
          local({ localKey: "1", syncId: LIVE_A.id, name: "whatever" }),
          local({ localKey: "2", syncId: DELETED.id, name: "whatever" }),
          local({ localKey: "3", name: "Unrelated" }),
        ],
      }),
    );
    assert.deepEqual(plan.plan, [
      { localKey: "1", action: "merge", playlistId: LIVE_A.id, serverName: "Rock" },
      { localKey: "2", action: "deleted", playlistId: DELETED.id, serverName: null },
      { localKey: "3", action: "create", playlistId: plan.plan[2]?.playlistId, serverName: null },
    ]);
    assert.notEqual(plan.plan[2]?.playlistId, "a0000000-0000-4000-8000-000000000009");
  });
});
