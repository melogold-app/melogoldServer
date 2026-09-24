/**
 * Quota boundary math (DESIGN §3.10, PLAN T2.2 "Делает: квоты на плейлист и в целом"): `oc.counters` loads the
 * `COUNT(*)` once per key, so these run against a fake `OpCtx` whose counters are pre-seeded — no rows, no database.
 * `playlists.int.test.ts` covers the same functions end to end through real handlers and a real database.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SYNC_LIMITS } from "../../../contract/limits.ts";
import { createRequestCounters } from "../ops/types.ts";
import type { OpCtx } from "../ops/types.ts";
import { ITEM_ROWS_COUNTER, itemQuotaAllows, LIVE_PLAYLISTS_COUNTER, livePlaylistQuotaAllows } from "./store.ts";

/** An `OpCtx` whose counters are already loaded, so the quota functions never touch `oc.q`. */
async function fakeOpCtx(seed: Readonly<{ live?: number; items?: number }>): Promise<OpCtx> {
  const counters = createRequestCounters();
  if (seed.live !== undefined) {
    const live = seed.live;
    await counters.get(LIVE_PLAYLISTS_COUNTER, () => Promise.resolve(live));
  }
  if (seed.items !== undefined) {
    const items = seed.items;
    await counters.get(ITEM_ROWS_COUNTER, () => Promise.resolve(items));
  }
  return { counters } as OpCtx;
}

describe("livePlaylistQuotaAllows (1000 live playlists)", () => {
  test("one more fits right up to the limit", async () => {
    const oc = await fakeOpCtx({ live: SYNC_LIMITS.maxPlaylists - 1 });
    assert.equal(await livePlaylistQuotaAllows(oc), true);
  });

  test("the limit itself does not leave room for one more", async () => {
    const oc = await fakeOpCtx({ live: SYNC_LIMITS.maxPlaylists });
    assert.equal(await livePlaylistQuotaAllows(oc), false);
  });
});

describe("itemQuotaAllows", () => {
  test("present items per playlist (10 000): the boundary is exact, and shrinking is always allowed", async () => {
    const oc = await fakeOpCtx({});
    assert.equal(await itemQuotaAllows(oc, SYNC_LIMITS.maxPlaylistItems - 1, 1, 0), true);
    assert.equal(await itemQuotaAllows(oc, SYNC_LIMITS.maxPlaylistItems, 1, 0), false);
    assert.equal(await itemQuotaAllows(oc, SYNC_LIMITS.maxPlaylistItems, -500, 0), true);
    assert.equal(await itemQuotaAllows(oc, SYNC_LIMITS.maxPlaylistItems, 0, 0), true);
  });

  test("no new rows never touches the row-count counter (a pure edit or a shrink costs nothing)", async () => {
    const oc = await fakeOpCtx({});
    assert.equal(await itemQuotaAllows(oc, 0, 0, 0), true);
    assert.equal(await itemQuotaAllows(oc, 0, -10, -10), true);
  });

  test("all item rows of the user, tombstones included (100 000): exact boundary", async () => {
    const atLimit = await fakeOpCtx({ items: SYNC_LIMITS.maxItemsTotal - 2 });
    assert.equal(await itemQuotaAllows(atLimit, 0, 2, 2), true);

    const overLimit = await fakeOpCtx({ items: SYNC_LIMITS.maxItemsTotal - 1 });
    assert.equal(await itemQuotaAllows(overLimit, 0, 2, 2), false);
  });

  test("the playlist cap is checked first and short-circuits: it never touches the row-count counter", async () => {
    const oc = await fakeOpCtx({}); // the row-count counter is not seeded; touching it would throw (no oc.q here)
    assert.equal(await itemQuotaAllows(oc, SYNC_LIMITS.maxPlaylistItems - 1, 10, 10), false);
  });
});
