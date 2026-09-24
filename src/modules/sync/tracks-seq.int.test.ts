/**
 * `sync_tracks.seq` on the real `/sync` route (DESIGN §3.3 "Метаданные строки перезаписываются и получают новый
 * seq, только если…"; PLAN T2.1 Приёмка "tracks-seq.int"):
 * - a stub replaced by real metadata moves `seq` (and the client's cursor sees the new row);
 * - real metadata replaced by more real metadata that changes only `thumbnailUrl` does **not** move `seq` — this is
 *   the anti-ping-pong guard between devices with different cached thumbnails;
 * - the other two triggers of DESIGN §3.3 — a changed `title`/`artistsText`, and a `durationMs` that was unknown
 *   becoming known — do move `seq`; identical metadata resent is a true no-op.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { LightMyRequestResponse } from "fastify";
import { newId } from "../../lib/ids.ts";
import { bearer, createAccount } from "../../test/factories.ts";
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

/**
 * Likes `videoId` (a fresh opId each time) with `tracks`, and returns the resulting `TrackDto` (API §4.1 — it has no
 * `seq`, only the internal `sync_tracks` row does) together with that row's real `seq` (via a direct read: the DTO
 * over the wire never carries it).
 */
async function like(
  videoId: string,
  tracks?: readonly Record<string, unknown>[],
): Promise<Record<string, unknown> & { seq: number }> {
  const response = json(
    await postSync({
      cursor: "",
      ops: [
        {
          opId: newId(),
          kind: "like.set",
          at: new Date(t.clock.now()).toISOString(),
          videoId,
          liked: true,
          ...(tracks ? { tracks } : {}),
        },
      ],
    }),
  );
  const result = (response.results as Record<string, unknown>[])[0];
  assert.equal(result?.status, "applied");
  const track = (response.tracks as Record<string, unknown>[]).find((row) => row.videoId === videoId);
  assert.ok(track, `no track row for ${videoId}`);
  const row = await t.db.read((q) =>
    q.selectFrom("sync_tracks").select("seq").where("video_id", "=", videoId).executeTakeFirstOrThrow(),
  );
  return { ...track, seq: row.seq };
}

function vid(n: number): string {
  return `t${String(n).padStart(10, "0")}`;
}

describe("tracks-seq.int (DESIGN §3.3)", () => {
  test("a stub (no metadata) moves seq once, on creation", async () => {
    const videoId = vid(1);
    const stub = await like(videoId);
    assert.equal(stub.metadataStub, true);
    assert.ok(stub.seq > 0);
  });

  test("a stub replaced by real metadata (same videoId) moves seq again", async () => {
    const videoId = vid(2);
    const stub = await like(videoId);
    assert.equal(stub.metadataStub, true);
    const real = await like(videoId, [{ videoId, title: "Дорога", artistsText: "Кино" }]);
    assert.equal(real.metadataStub, false);
    assert.ok(real.seq > stub.seq, "stub → real metadata must move seq");
  });

  test("changing only thumbnailUrl on an already-real row does NOT move seq (anti ping-pong)", async () => {
    const videoId = vid(3);
    const first = await like(videoId, [
      { videoId, title: "Дорога", artistsText: "Кино", thumbnailUrl: "https://img.example/a.jpg" },
    ]);
    assert.equal(first.metadataStub, false);
    const second = await like(videoId, [
      { videoId, title: "Дорога", artistsText: "Кино", thumbnailUrl: "https://img.example/b-different.jpg" },
    ]);
    assert.equal(second.seq, first.seq, "a new thumbnailUrl alone must not move seq");
    // The row is not silently ignored — its thumbnail truly is not updated either, matching the DESIGN rule
    // ("новый thumbnailUrl строку не двигает") literally: the stored image keeps the first thumbnail.
    assert.equal(second.thumbnailUrl, "https://img.example/a.jpg");
  });

  test("resending the exact same real metadata is a true no-op: seq does not move", async () => {
    const videoId = vid(4);
    const first = await like(videoId, [{ videoId, title: "Трек", artistsText: "Артист" }]);
    const second = await like(videoId, [{ videoId, title: "Трек", artistsText: "Артист" }]);
    assert.equal(second.seq, first.seq);
  });

  test("a changed title moves seq", async () => {
    const videoId = vid(5);
    const first = await like(videoId, [{ videoId, title: "Старое имя" }]);
    const second = await like(videoId, [{ videoId, title: "Новое имя" }]);
    assert.ok(second.seq > first.seq);
    assert.equal(second.title, "Новое имя");
  });

  test("a changed artistsText moves seq", async () => {
    const videoId = vid(6);
    const first = await like(videoId, [{ videoId, title: "Трек", artistsText: "Старый артист" }]);
    const second = await like(videoId, [{ videoId, title: "Трек", artistsText: "Новый артист" }]);
    assert.ok(second.seq > first.seq);
  });

  test("durationMs becoming known (was null) moves seq, even with title/artistsText unchanged", async () => {
    const videoId = vid(7);
    const first = await like(videoId, [{ videoId, title: "Трек", artistsText: "Артист" }]);
    assert.equal(first.durationMs, null);
    const second = await like(videoId, [{ videoId, title: "Трек", artistsText: "Артист", durationMs: 200_000 }]);
    assert.ok(second.seq > first.seq);
    assert.equal(second.durationMs, 200_000);
  });

  test("durationMs already known does not move seq when a new durationMs alone changes (not a listed trigger)", async () => {
    const videoId = vid(8);
    const first = await like(videoId, [{ videoId, title: "Трек", artistsText: "Артист", durationMs: 100_000 }]);
    const second = await like(videoId, [{ videoId, title: "Трек", artistsText: "Артист", durationMs: 999_000 }]);
    assert.equal(second.seq, first.seq, "only title/artistsText/unknown→known duration move seq, per DESIGN §3.3");
    assert.equal(second.durationMs, 100_000, "the stored duration is unchanged too");
  });

  test("a stub is never replaced by another stub (no metadata sent again): seq does not move", async () => {
    const videoId = vid(9);
    const first = await like(videoId);
    const second = await like(videoId); // no tracks[] at all
    assert.equal(second.seq, first.seq);
    assert.equal(second.metadataStub, true);
  });
});
