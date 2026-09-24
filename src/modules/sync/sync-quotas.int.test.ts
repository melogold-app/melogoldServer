/**
 * Quotas and the request budget on the real `/sync` route (DESIGN §3.10, API §1.9, §11 `ServerLimits.sync`; PLAN
 * T2.1 Приёмка "sync-quotas.int"):
 * - a new row that would cross a live `COUNT(*)` quota is `deferred quota_exceeded`, and spends no `seq`;
 * - Σ(videoIds + entries + tracks) over the ops, above 20 000, is `413 payload_too_large` for the whole request,
 *   checked before any write.
 *
 * The bookmarks quota (20 000 per type) is used for the "at the limit" case: it is real end-to-end coverage of
 * `quotas.ts`'s `tryConsume`/`quotaUsage` against a live `COUNT(*)`, at a size this suite can seed quickly. The
 * likes quota (100 000, `LIKES_QUOTA`) and every other {@link import("./quotas.ts").Quota} share the exact same
 * `tryConsume` logic (`quotas.ts`), which a fast, DB-free unit test covers at its own boundary below.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { LightMyRequestResponse } from "fastify";
import { SYNC_LIMITS } from "../../contract/limits.ts";
import { insertInChunks } from "../../db/batch.ts";
import { toDbBool } from "../../db/codecs.ts";
import { newId } from "../../lib/ids.ts";
import { bearer, createAccount } from "../../test/factories.ts";
import type { TestAccount } from "../../test/factories.ts";
import { createTestApp, json } from "../../test/test-app.ts";
import type { TestApp } from "../../test/test-app.ts";
import { createRequestCounters } from "./ops/types.ts";
import { LIKES_QUOTA, release, tryConsume } from "./quotas.ts";

describe("tryConsume/release (DESIGN §3.10), DB-free", () => {
  test("reserves rows up to the limit, refuses the one that would cross it, and release() gives rows back", async () => {
    const counters = createRequestCounters();
    let counted = 0;
    const oc = { q: undefined as never, userId: "u", counters };
    const quota = { key: "fake", limit: 2, count: () => Promise.resolve(counted) };

    assert.equal(await tryConsume(oc, quota), true); // 0 -> 1
    assert.equal(await tryConsume(oc, quota), true); // 1 -> 2 (at the limit)
    assert.equal(await tryConsume(oc, quota), false); // 2 + 1 > 2: refused
    release(oc, quota); // a row was removed elsewhere in the same request
    assert.equal(await tryConsume(oc, quota), true); // room again
    counted = 999; // the live COUNT(*) is read only once per request, then kept in memory
    assert.equal(await quota.count(), 999);
  });

  test("LIKES_QUOTA's own limit matches API §11 (100 000), independent of any DB row count", () => {
    assert.equal(LIKES_QUOTA.limit, SYNC_LIMITS.maxLikes);
    assert.equal(LIKES_QUOTA.limit, 100_000);
  });
});

describe("sync-quotas.int: quota_exceeded end-to-end (DESIGN §3.10)", () => {
  let t: TestApp;
  let account: TestAccount;

  before(async () => {
    t = await createTestApp();
    account = await createAccount(t.ctx);
  });

  after(async () => {
    await t.close();
  });

  function postSync(body: Record<string, unknown>): Promise<LightMyRequestResponse> {
    return t.app.inject({
      method: "POST",
      url: "/sync",
      headers: {
        ...bearer(account.session.tokens.accessToken),
        "x-sync-protocol": "1",
        "content-type": "application/json",
      },
      payload: JSON.stringify(body),
    });
  }

  test("a new bookmark at the 20 000 quota is deferred quota_exceeded and spends no seq", async () => {
    const now = t.clock.now();
    const rows = Array.from({ length: SYNC_LIMITS.maxBookmarksPerType }, (_, i) => ({
      user_id: account.user.id,
      type: "album",
      browse_id: `q${String(i).padStart(19, "0")}`,
      bookmarked: toDbBool(true),
      bookmarked_at: now,
      title: null,
      subtitle: null,
      thumbnail_url: null,
      year: null,
      seq: i + 1,
      clk_at: now,
      clk_dev: null,
    }));
    await insertInChunks(rows, (chunk) => t.db.write((q) => q.insertInto("sync_bookmarks").values(chunk).execute()));
    await t.db.write((q) =>
      q.updateTable("sync_heads").set({ seq: rows.length }).where("user_id", "=", account.user.id).execute(),
    );
    const headSeq = () =>
      t.db.read((q) =>
        q
          .selectFrom("sync_heads")
          .select("seq")
          .where("user_id", "=", account.user.id)
          .executeTakeFirstOrThrow()
          .then((row) => row.seq),
      );
    const before = await headSeq();

    const response = json(
      await postSync({
        cursor: "",
        ops: [
          {
            opId: newId(),
            kind: "bookmark.set",
            at: new Date(now).toISOString(),
            type: "album",
            browseId: "q_one_over_the_limit",
            bookmarked: true,
          },
        ],
      }),
    );
    const result = (response.results as Record<string, unknown>[])[0];
    assert.equal(result?.status, "deferred");
    assert.equal(result.code, "quota_exceeded");
    assert.equal(result.seq, null);
    assert.equal(await headSeq(), before, "the head did not move: no seq was spent");

    // A bookmark of a DIFFERENT type is unaffected: quotas are per (key), here per bookmark type.
    const artist = json(
      await postSync({
        cursor: "",
        ops: [
          {
            opId: newId(),
            kind: "bookmark.set",
            at: new Date(now).toISOString(),
            type: "artist",
            browseId: "UCsomeartist1",
            bookmarked: true,
          },
        ],
      }),
    );
    assert.equal((artist.results as Record<string, unknown>[])[0]?.status, "applied");
  });

  test("an update of an already-bookmarked row is never refused by the quota (only new rows are counted)", async () => {
    const now = t.clock.now();
    const response = json(
      await postSync({
        cursor: "",
        ops: [
          {
            opId: newId(),
            kind: "bookmark.set",
            at: new Date(now).toISOString(),
            type: "album",
            browseId: `q${String(0).padStart(19, "0")}`,
            bookmarked: true,
            title: "Обновлённое имя",
          },
        ],
      }),
    );
    assert.equal((response.results as Record<string, unknown>[])[0]?.status, "applied");
  });

  test("Σ(videoIds + entries + tracks) over 20 000 is 413 payload_too_large, before any write", async () => {
    const before = json(await postSync({ cursor: "", ops: [] }));
    const tracks = Array.from({ length: SYNC_LIMITS.maxWorkUnitsPerRequest + 1 }, (_, i) => ({
      videoId: `w${String(i).padStart(10, "0")}`,
      title: "x",
    }));
    const response = await postSync({
      cursor: "",
      ops: [
        {
          opId: newId(),
          kind: "like.set",
          at: new Date(t.clock.now()).toISOString(),
          videoId: "w0000000000",
          liked: true,
          tracks,
        },
      ],
    });
    assert.equal(response.statusCode, 413);
    assert.equal(json(response).code, "payload_too_large");

    const after = json(await postSync({ cursor: "", ops: [] }));
    assert.equal(after.cursor, before.cursor, "nothing was written before the budget check tripped");
  });

  test("exactly at the work budget (20 000) is not refused by the budget check", async () => {
    const tracks = Array.from({ length: SYNC_LIMITS.maxWorkUnitsPerRequest }, (_, i) => ({
      videoId: `x${String(i).padStart(10, "0")}`,
      title: "x",
    }));
    const response = await postSync({
      cursor: "",
      ops: [
        {
          opId: newId(),
          kind: "like.set",
          at: new Date(t.clock.now()).toISOString(),
          videoId: "x0000000000",
          liked: true,
          tracks,
        },
      ],
    });
    assert.equal(response.statusCode, 200, response.body);
  });
});
