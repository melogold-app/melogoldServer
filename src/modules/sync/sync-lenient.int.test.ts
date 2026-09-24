/**
 * Lenient metadata parsing on the real `/sync` route (DESIGN §3.9 "Метаданные никогда не приводят к отказу", §3.3
 * track stubs, API §4.8 "Мягкая нормализация"; PLAN T2.1 Приёмка "sync-lenient.int"): garbage `tracks[]` and
 * bookmark metadata never refuse the op — the field is cleaned or the track becomes a stub — while a bad
 * **structural** field (a videoId, or `bookmark.set.type`) still ends the op the strict way, for contrast.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { LightMyRequestResponse } from "fastify";
import { STRING_LIMITS } from "../../contract/limits.ts";
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

function vid(n: number): string {
  return `l${String(n).padStart(10, "0")}`;
}

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

/** Likes `videoId` with `tracks` and returns the resulting `TrackDto` (always present: liked videos satellite in). */
async function likeWithTrack(
  videoId: string,
  tracks: readonly Record<string, unknown>[],
): Promise<Record<string, unknown>> {
  const response = json(
    await postSync({
      cursor: "",
      ops: [
        { opId: newId(), kind: "like.set", at: new Date(t.clock.now()).toISOString(), videoId, liked: true, tracks },
      ],
    }),
  );
  const result = (response.results as Record<string, unknown>[])[0];
  assert.equal(result?.status, "applied", "garbage metadata never refuses the op");
  const track = (response.tracks as Record<string, unknown>[]).find((row) => row.videoId === videoId);
  assert.ok(track, `no track row for ${videoId}`);
  return track;
}

describe("sync-lenient.int: tracks[] (DESIGN §3.3, §3.9)", () => {
  test("an empty title makes a metadata stub: title = videoId, applied all the same", async () => {
    const videoId = vid(1);
    const track = await likeWithTrack(videoId, [{ videoId, title: "" }]);
    assert.equal(track.metadataStub, true);
    assert.equal(track.title, videoId);
  });

  test("a blank (whitespace-only) title is also a stub", async () => {
    const videoId = vid(2);
    const track = await likeWithTrack(videoId, [{ videoId, title: "   " }]);
    assert.equal(track.metadataStub, true);
  });

  test("artistsText of 10 000 characters is truncated to the 500-unit limit, not rejected", async () => {
    const videoId = vid(3);
    const huge = "я".repeat(10_000);
    const track = await likeWithTrack(videoId, [{ videoId, title: "Трек", artistsText: huge }]);
    assert.equal(track.metadataStub, false);
    assert.equal((track.artistsText as string).length, STRING_LIMITS.title);
    assert.equal(track.artistsText, huge.slice(0, STRING_LIMITS.title));
  });

  test("an ftp:// thumbnailUrl (not http/https) becomes null, not a refused op", async () => {
    const videoId = vid(4);
    const track = await likeWithTrack(videoId, [{ videoId, title: "Трек", thumbnailUrl: "ftp://example.com/a.jpg" }]);
    assert.equal(track.thumbnailUrl, null);
  });

  test("an invalid videoType (not [a-z_]{1,32}) becomes null", async () => {
    const videoId = vid(5);
    const track = await likeWithTrack(videoId, [{ videoId, title: "Трек", videoType: "Not Valid!" }]);
    assert.equal(track.videoType, null);
  });

  test("durationText alone derives durationMs (m:ss)", async () => {
    const videoId = vid(6);
    const track = await likeWithTrack(videoId, [{ videoId, title: "Трек", durationText: "4:14" }]);
    assert.equal(track.durationMs, 254_000);
    assert.equal(track.durationText, "4:14");
  });

  test("durationMs alone derives durationText (h:mm:ss past one hour)", async () => {
    const videoId = vid(7);
    const track = await likeWithTrack(videoId, [{ videoId, title: "Трек", durationMs: 3_723_000 }]);
    assert.equal(track.durationText, "1:02:03");
  });

  test("a malformed durationText (not m:ss or h:mm:ss) is kept verbatim but derives no durationMs", async () => {
    const videoId = vid(8);
    const track = await likeWithTrack(videoId, [{ videoId, title: "Трек", durationText: "not a duration" }]);
    assert.equal(track.durationMs, null, "it does not parse as m:ss or h:mm:ss");
    assert.equal(track.durationText, "not a duration", "durationText is a display string, not itself validated");
  });

  test("artists[]: an invalid item is dropped, a valid one with a bad id keeps its name and drops the id", async () => {
    const videoId = vid(9);
    const track = await likeWithTrack(videoId, [
      {
        videoId,
        title: "Трек",
        artists: ["not an object", 42, null, { name: "   " }, { id: "bad id with spaces", name: "Кино" }],
      },
    ]);
    assert.deepEqual(track.artists, [{ id: null, name: "Кино" }]);
  });

  test("a wrong-type field (durationMs as a string) is null, not a validation error", async () => {
    const videoId = vid(10);
    const track = await likeWithTrack(videoId, [{ videoId, title: "Трек", durationMs: "254000" }]);
    assert.equal(track.durationMs, null);
  });

  test("an unrelated videoId in tracks[] (not the op's own) creates no stray row", async () => {
    const videoId = vid(11);
    const strangerId = vid(12);
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
            tracks: [{ videoId: strangerId, title: "Чужой" }],
          },
        ],
      }),
    );
    const tracks = response.tracks as Record<string, unknown>[];
    assert.ok(tracks.some((row) => row.videoId === videoId));
    assert.ok(!tracks.some((row) => row.videoId === strangerId), "only videoIds the op names get a row");
    const direct = await t.db.read((q) =>
      q.selectFrom("sync_tracks").select("video_id").where("video_id", "=", strangerId).executeTakeFirst(),
    );
    assert.equal(direct, undefined);
  });

  test("no tracks[] at all still gets a stub row (title = videoId)", async () => {
    const videoId = vid(13);
    const response = json(
      await postSync({
        cursor: "",
        ops: [{ opId: newId(), kind: "like.set", at: new Date(t.clock.now()).toISOString(), videoId, liked: true }],
      }),
    );
    const track = (response.tracks as Record<string, unknown>[]).find((row) => row.videoId === videoId);
    assert.ok(track);
    assert.equal(track.metadataStub, true);
    assert.equal(track.title, videoId);
  });
});

describe("sync-lenient.int: bookmark.set metadata (DESIGN §3.9)", () => {
  test("garbage title/subtitle/year/thumbnailUrl are cleaned, never refused", async () => {
    const browseId = "MPREb_garbage1";
    const response = json(
      await postSync({
        cursor: "",
        ops: [
          {
            opId: newId(),
            kind: "bookmark.set",
            at: new Date(t.clock.now()).toISOString(),
            type: "album",
            browseId,
            bookmarked: true,
            title: "я".repeat(600),
            subtitle: 12345, // wrong type
            thumbnailUrl: "javascript:alert(1)",
            year: "", // empty → null
          },
        ],
      }),
    );
    const result = (response.results as Record<string, unknown>[])[0];
    assert.equal(result?.status, "applied");
    const bookmark = (response.bookmarks as Record<string, unknown>[])[0];
    assert.ok(bookmark);
    assert.equal((bookmark.title as string).length, STRING_LIMITS.title);
    assert.equal(bookmark.subtitle, null);
    assert.equal(bookmark.thumbnailUrl, null);
    assert.equal(bookmark.year, null);
  });

  test("contrast: an invalid bookmark.set.type is a structural failure (deferred invalid_payload), not lenient", async () => {
    const response = json(
      await postSync({
        cursor: "",
        ops: [
          {
            opId: newId(),
            kind: "bookmark.set",
            at: new Date(t.clock.now()).toISOString(),
            type: "playlist", // not album|artist
            browseId: "MPREb_x",
            bookmarked: true,
          },
        ],
      }),
    );
    const result = (response.results as Record<string, unknown>[])[0];
    assert.equal(result?.status, "deferred");
    assert.equal(result.code, "invalid_payload");
  });

  test("contrast: a malformed videoId on like.set is rejected invalid_video_id, not cleaned", async () => {
    const response = json(
      await postSync({
        cursor: "",
        ops: [
          {
            opId: newId(),
            kind: "like.set",
            at: new Date(t.clock.now()).toISOString(),
            videoId: "not-11-chars",
            liked: true,
          },
        ],
      }),
    );
    const result = (response.results as Record<string, unknown>[])[0];
    assert.equal(result?.status, "rejected");
    assert.equal(result.code, "invalid_video_id");
  });
});
