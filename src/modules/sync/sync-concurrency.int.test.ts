/**
 * Concurrent `POST /sync` of one user, on both dialects (docs/database.md `lockUser`/`BEGIN IMMEDIATE`/`FOR UPDATE`;
 * DESIGN §3.5 "порядок seq совпадает с порядком коммитов"; PLAN T2.1 Приёмка "sync-concurrency.int"):
 * - 20 parallel `/sync` writes of the same user (from several devices) each get their own `seq`, strictly growing,
 *   with no gaps and no duplicate — the single-writer mutex (`sync_heads` row lock) serializes them correctly;
 * - a pull from the empty cursor after they all land matches a direct read of the tables: nothing was lost or
 *   duplicated by the concurrent writers.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { LightMyRequestResponse } from "fastify";
import { newId } from "../../lib/ids.ts";
import { bearer, createAccount, createDevice, createSession } from "../../test/factories.ts";
import type { TestAccount } from "../../test/factories.ts";
import { createTestApp, json } from "../../test/test-app.ts";
import type { TestApp } from "../../test/test-app.ts";

let t: TestApp;
let account: TestAccount;

before(async () => {
  t = await createTestApp();
  account = await createAccount(t.ctx);
});

after(async () => {
  await t.close();
});

function vid(n: number): string {
  return `c${String(n).padStart(10, "0")}`;
}

function postSync(token: string, body: Record<string, unknown>): Promise<LightMyRequestResponse> {
  return t.app.inject({
    method: "POST",
    url: "/sync",
    headers: { ...bearer(token), "x-sync-protocol": "1", "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
}

describe("sync-concurrency.int (DESIGN §3.5, §3.8)", () => {
  test("20 parallel writes from 4 devices: seq strictly grows, one writer at a time, no duplicates", async () => {
    const devices = await Promise.all(
      [0, 1, 2, 3].map(async (i) => {
        if (i === 0) return account.session.tokens.accessToken;
        const device = await createDevice(t.db, account.user.id, { id: newId() });
        const session = await createSession(t.ctx, { userId: account.user.id, deviceId: device.id });
        return session.tokens.accessToken;
      }),
    );

    const requests = Array.from({ length: 20 }, (_, i) => {
      const token = devices[i % devices.length];
      const op = {
        opId: newId(),
        kind: "like.set",
        at: new Date(t.clock.now() + i).toISOString(),
        videoId: vid(i),
        liked: true,
      };
      return postSync(token!, { cursor: "", ops: [op] });
    });

    const responses = await Promise.all(requests);
    const seqs: number[] = [];
    for (const response of responses) {
      assert.equal(response.statusCode, 200, response.body);
      const body = json(response);
      const result = (body.results as Record<string, unknown>[])[0];
      assert.equal(result?.status, "applied");
      assert.equal(typeof result.seq, "number");
      seqs.push(result.seq as number);
    }
    seqs.sort((a, b) => a - b);
    // Each op also writes a fresh track stub and its own sync_ops journal row (its own seq each), so consecutive
    // reported seqs are not `+1` apart — but every write of this user (`lockUser`) is strictly serialized, so the
    // 20 reported journal seqs must all be distinct, strictly increasing, and the head must land exactly on the
    // last one (nothing else touched this user's seq counter after the last commit).
    assert.equal(new Set(seqs).size, 20, "no two concurrent writers were handed the same seq");
    for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i]! > seqs[i - 1]!, `seq must strictly grow: ${seqs.join()}`);

    const head = await t.db.read((q) =>
      q.selectFrom("sync_heads").select("seq").where("user_id", "=", account.user.id).executeTakeFirstOrThrow(),
    );
    assert.equal(head.seq, Math.max(...seqs), "the head lands exactly on the last commit's last seq");
  });

  test("a pull from zero matches a direct read of sync_likes (nothing lost or duplicated)", async () => {
    const token = account.session.tokens.accessToken;
    const page = json(await postSync(token, { cursor: "", limit: 2000, ops: [] }));
    assert.equal(page.hasMore, false);
    const likesFromSync = (page.likes as { videoId: string; liked: boolean }[]).map((row) => row.videoId).sort();

    const direct = await t.db.read((q) =>
      q.selectFrom("sync_likes").select(["video_id"]).where("user_id", "=", account.user.id).execute(),
    );
    const likesFromDb = direct.map((row) => row.video_id).sort();

    assert.deepEqual(likesFromSync, likesFromDb);
    assert.equal(likesFromSync.length, 20);
  });
});
