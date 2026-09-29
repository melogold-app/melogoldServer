/**
 * Snapshots of own playlists by link over HTTP (API §4.11, server task 0003), both dialects: create, list, the public
 * JSON and the browser page `/s/{id}` (escaping, 404 page, deep link, `watch_videos`), delete, the 200-snapshot limit,
 * the rate limit of `POST /shares`, export (§4.5) and `features.share`.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { LightMyRequestResponse } from "fastify";
import { SHARE_ID_PATTERN, SHARE_LIMITS } from "../../contract/limits.ts";
import { formatIso } from "../../lib/time.ts";
import { bearer, createAccount } from "../../test/factories.ts";
import { createTestApp, json } from "../../test/test-app.ts";
import type { TestApp } from "../../test/test-app.ts";
import { WATCH_VIDEOS_MAX } from "./shares.page.ts";

const TRACK = {
  videoId: "dQw4w9WgXcQ",
  title: "Never Gonna Give You Up",
  artistsText: "Rick Astley",
  durationMs: 213_000,
};
const OTHER = { videoId: "a1B2c3D4e5F", title: "Song", durationText: "3:45" };

let t: TestApp;

before(async () => {
  t = await createTestApp({ env: { PUBLIC_URL: "https://music.example.com" } });
});

after(async () => {
  await t.close();
});

function create(token: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return t.app.inject({
    method: "POST",
    url: "/shares",
    headers: { ...bearer(token), "content-type": "application/json", ...headers },
    payload: JSON.stringify(body),
  });
}

async function created(token: string, body: Record<string, unknown>): Promise<Record<string, string>> {
  const response = await create(token, body);
  assert.equal(response.statusCode, 201, response.body);
  return json(response) as Record<string, string>;
}

const page = (id: string, headers: Record<string, string> = {}): Promise<LightMyRequestResponse> =>
  t.app.inject({ method: "GET", url: `/s/${id}`, headers });

describe("POST /shares", () => {
  test("201 with a 10-character id, the public URL and createdAt; the owner reads it back", async () => {
    const account = await createAccount(t.ctx);
    const token = account.session.tokens.accessToken;
    const share = await created(token, { kind: "playlist", name: "  Road trip  ", tracks: [TRACK, OTHER] });
    assert.match(share.shareId ?? "", SHARE_ID_PATTERN);
    assert.equal(share.url, `https://music.example.com/s/${share.shareId}`);
    assert.equal(share.createdAt, formatIso(t.clock.now()));

    const list = json(await t.app.inject({ method: "GET", url: "/shares", headers: bearer(token) }));
    const shares = list.shares as Record<string, unknown>[];
    assert.equal(shares.length, 1);
    const first = shares[0];
    assert.ok(first);
    assert.equal(first.shareId, share.shareId);
    assert.equal(first.kind, "playlist");
    assert.equal(first.name, "Road trip");
    assert.equal(first.url, share.url);
    const tracks = first.tracks as Record<string, unknown>[];
    assert.deepEqual(
      tracks.map((track) => [track.videoId, track.title, track.artistsText]),
      [
        [TRACK.videoId, TRACK.title, TRACK.artistsText],
        [OTHER.videoId, OTHER.title, null],
      ],
    );
  });

  test("a blank name becomes «Без названия» by Accept-Language, else «Untitled»", async () => {
    const account = await createAccount(t.ctx);
    const token = account.session.tokens.accessToken;
    const ru = json(
      await create(token, { kind: "playlist", name: "   ", tracks: [TRACK] }, { "accept-language": "ru-RU,ru;q=0.9" }),
    );
    const en = await created(token, { kind: "playlist", name: " ", tracks: [TRACK] });
    const names = async (id: unknown) => json(await t.app.inject({ method: "GET", url: `/shares/${String(id)}` })).name;
    assert.equal(await names(ru.shareId), "Без названия");
    assert.equal(await names(en.shareId), "Untitled");
  });

  test("400 invalid_request: an unknown kind, no tracks, a bad videoId, a too long name", async () => {
    const account = await createAccount(t.ctx);
    const token = account.session.tokens.accessToken;
    for (const body of [
      { kind: "album", name: "A", tracks: [TRACK] },
      { kind: "playlist", name: "A", tracks: [] },
      { kind: "playlist", name: "A", tracks: [{ videoId: "short", title: "x" }] },
      { kind: "playlist", name: "x".repeat(201), tracks: [TRACK] },
    ]) {
      const response = await create(token, body);
      assert.equal(response.statusCode, 400, JSON.stringify(body));
      assert.equal(json(response).code, "invalid_request");
    }
  });

  test("401 without a token", async () => {
    const response = await t.app.inject({
      method: "POST",
      url: "/shares",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ kind: "playlist", name: "A", tracks: [TRACK] }),
    });
    assert.equal(response.statusCode, 401);
  });

  test(`409 share_limit_reached beyond ${SHARE_LIMITS.maxShares} snapshots`, async () => {
    const account = await createAccount(t.ctx);
    const token = account.session.tokens.accessToken;
    const rows = Array.from({ length: SHARE_LIMITS.maxShares }, (_, index) => ({
      id: `limit${String(index).padStart(5, "0")}`,
      user_id: account.user.id,
      kind: "playlist",
      name: `P${index}`,
      tracks: "[]",
      created_at: t.clock.now(),
    }));
    await t.db.write((q) => q.insertInto("shares").values(rows).execute());
    const response = await create(token, { kind: "playlist", name: "One more", tracks: [TRACK] });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(json(response).code, "share_limit_reached");
    assert.equal(json(response).maxShares, SHARE_LIMITS.maxShares);

    const del = await t.app.inject({ method: "DELETE", url: "/shares/limit00000", headers: bearer(token) });
    assert.equal(del.statusCode, 204);
    await created(token, { kind: "playlist", name: "Now fits", tracks: [TRACK] });
  });
});

describe("GET /shares", () => {
  test("only the caller's, newest first", async () => {
    const owner = await createAccount(t.ctx);
    const stranger = await createAccount(t.ctx);
    const first = await created(owner.session.tokens.accessToken, { kind: "playlist", name: "Old", tracks: [TRACK] });
    t.clock.advance(1000);
    const second = await created(owner.session.tokens.accessToken, { kind: "playlist", name: "New", tracks: [TRACK] });
    await created(stranger.session.tokens.accessToken, { kind: "playlist", name: "Theirs", tracks: [TRACK] });
    const list = json(
      await t.app.inject({ method: "GET", url: "/shares", headers: bearer(owner.session.tokens.accessToken) }),
    );
    assert.deepEqual(
      (list.shares as { shareId: string }[]).map((share) => share.shareId),
      [second.shareId, first.shareId],
    );
  });
});

describe("GET /shares/{shareId} (public)", () => {
  test("the snapshot without sign-in, without the owner; 404 share_not_found; 400 on a malformed id", async () => {
    const account = await createAccount(t.ctx);
    const share = await created(account.session.tokens.accessToken, {
      kind: "playlist",
      name: "Mix",
      tracks: [TRACK],
    });
    const response = await t.app.inject({ method: "GET", url: `/shares/${share.shareId}` });
    assert.equal(response.statusCode, 200, response.body);
    const body = json(response);
    assert.deepEqual(Object.keys(body).sort(), ["createdAt", "kind", "name", "shareId", "tracks", "url"]);
    assert.ok(!response.body.includes(account.user.id) && !response.body.includes(account.user.login));

    const missing = await t.app.inject({ method: "GET", url: "/shares/AAAAAAAAAA" });
    assert.equal(missing.statusCode, 404);
    assert.equal(json(missing).code, "share_not_found");
    const malformed = await t.app.inject({ method: "GET", url: "/shares/abc" });
    assert.equal(malformed.statusCode, 400);
  });
});

describe("GET /s/{shareId} (the page)", () => {
  test("escaped name and tracks, deep link, watch_videos, noindex, strict CSP, no script", async () => {
    const account = await createAccount(t.ctx);
    const evil = { videoId: "x1Y2z3W4v5U", title: "<img src=x onerror=alert(1)>", artistsText: `"Q" & <b>` };
    const share = await created(account.session.tokens.accessToken, {
      kind: "playlist",
      name: "<script>alert('x')</script>",
      tracks: [TRACK, evil],
    });
    const response = await page(share.shareId ?? "", { "accept-language": "ru" });
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers["content-type"]), /^text\/html; charset=utf-8/);
    const csp = String(response.headers["content-security-policy"]);
    assert.match(csp, /default-src 'none'/);
    const html = response.body;
    assert.ok(!html.includes("<script"), "no script at all");
    assert.ok(!html.includes("<img"), "track titles are escaped");
    assert.ok(html.includes("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;"), html);
    assert.ok(html.includes("&quot;Q&quot; &amp; &lt;b&gt; — &lt;img src=x onerror=alert(1)&gt;"), html);
    assert.ok(html.includes('<meta name="robots" content="noindex">'));
    assert.ok(html.includes("2 трека"));
    assert.ok(html.includes('Rick Astley — Never Gonna Give You Up</a> <span class="time">3:33</span>'));
    assert.ok(
      html.includes(
        `href="melogold://share?v=1&amp;url=${encodeURIComponent("https://music.example.com")}&amp;id=${share.shareId}"`,
      ),
      html,
    );
    assert.ok(html.includes(`https://www.youtube.com/watch_videos?video_ids=${TRACK.videoId},${evil.videoId}`));
    assert.ok(html.includes(`https://music.youtube.com/watch?v=${TRACK.videoId}`));
    assert.ok(!html.includes(account.user.login), "the owner is not disclosed");
  });

  test("English without a Russian Accept-Language; watch_videos takes the first 50 tracks", async () => {
    const account = await createAccount(t.ctx);
    const tracks = Array.from({ length: WATCH_VIDEOS_MAX + 5 }, (_, index) => ({
      videoId: `v${String(index).padStart(10, "0")}`,
      title: `T${index}`,
    }));
    const share = await created(account.session.tokens.accessToken, { kind: "playlist", name: "Long", tracks });
    const html = (await page(share.shareId ?? "")).body;
    assert.ok(html.includes('<html lang="en">'));
    assert.ok(html.includes("55 tracks") && html.includes("Open in Melogold"));
    const ids = /watch_videos\?video_ids=([^"]+)"/.exec(html)?.[1]?.split(",") ?? [];
    assert.equal(ids.length, WATCH_VIDEOS_MAX);
    assert.equal(ids.at(-1), tracks[WATCH_VIDEOS_MAX - 1]?.videoId);
  });

  test("404 page for a missing, deleted or malformed id", async () => {
    const account = await createAccount(t.ctx);
    const token = account.session.tokens.accessToken;
    const share = await created(token, { kind: "playlist", name: "Gone soon", tracks: [TRACK] });
    assert.equal((await page(share.shareId ?? "")).statusCode, 200);
    const del = await t.app.inject({ method: "DELETE", url: `/shares/${share.shareId}`, headers: bearer(token) });
    assert.equal(del.statusCode, 204);
    for (const id of [share.shareId ?? "", "AAAAAAAAAA", "..%2F..%2Fetc", "<b>"]) {
      const response = await page(id, { "accept-language": "ru" });
      assert.equal(response.statusCode, 404, id);
      assert.ok(response.body.includes("Ссылка удалена или неверна"), id);
      assert.ok(!response.body.includes("<b>"), id);
    }
  });
});

describe("DELETE /shares/{shareId}", () => {
  test("only the owner: someone else's → 404 share_not_found and the link keeps working; a second delete → 404", async () => {
    const owner = await createAccount(t.ctx);
    const stranger = await createAccount(t.ctx);
    const share = await created(owner.session.tokens.accessToken, { kind: "playlist", name: "Mine", tracks: [TRACK] });
    const foreign = await t.app.inject({
      method: "DELETE",
      url: `/shares/${share.shareId}`,
      headers: bearer(stranger.session.tokens.accessToken),
    });
    assert.equal(foreign.statusCode, 404);
    assert.equal(json(foreign).code, "share_not_found");
    assert.equal((await t.app.inject({ method: "GET", url: `/shares/${share.shareId}` })).statusCode, 200);

    const own = () =>
      t.app.inject({
        method: "DELETE",
        url: `/shares/${share.shareId}`,
        headers: bearer(owner.session.tokens.accessToken),
      });
    assert.equal((await own()).statusCode, 204);
    assert.equal((await own()).statusCode, 404);
    assert.equal((await t.app.inject({ method: "GET", url: `/shares/${share.shareId}` })).statusCode, 404);
  });
});

describe("export and features", () => {
  test("GET /auth/me/export lists the snapshots", async () => {
    const account = await createAccount(t.ctx);
    const token = account.session.tokens.accessToken;
    const share = await created(token, { kind: "playlist", name: "Exported", tracks: [TRACK] });
    const response = await t.app.inject({ method: "GET", url: "/auth/me/export", headers: bearer(token) });
    assert.equal(response.statusCode, 200, response.body);
    const shares = json(response).shares as Record<string, unknown>[];
    assert.equal(shares.length, 1);
    assert.equal(shares[0]?.shareId, share.shareId);
    assert.equal(shares[0]?.name, "Exported");
    assert.equal(shares[0].url, share.url);
  });

  test("GET /server/info: features.share and limits.share", async () => {
    const info = json(await t.app.inject({ method: "GET", url: "/server/info" }));
    assert.deepEqual((info.features as Record<string, unknown>).share, { version: 1 });
    assert.deepEqual((info.limits as Record<string, unknown>).share, {
      maxShares: SHARE_LIMITS.maxShares,
      maxTracks: SHARE_LIMITS.maxTracks,
    });
  });
});

describe("rate limits", () => {
  test("POST /shares: 20 per hour per user", async () => {
    const limited = await createTestApp({ env: { RATE_LIMIT_ENABLED: "true" } });
    try {
      const account = await createAccount(limited.ctx);
      const post = () =>
        limited.app.inject({
          method: "POST",
          url: "/shares",
          headers: { ...bearer(account.session.tokens.accessToken), "content-type": "application/json" },
          payload: JSON.stringify({ kind: "playlist", name: "R", tracks: [TRACK] }),
        });
      for (let i = 0; i < 20; i++) assert.equal((await post()).statusCode, 201, `request ${i + 1}`);
      const limitedResponse = await post();
      assert.equal(limitedResponse.statusCode, 429);
      assert.equal(json(limitedResponse).code, "rate_limited");
    } finally {
      await limited.close();
    }
  });
});
