/**
 * The lyrics module over HTTP (API §4.10), on both dialects (`npm test`, `npm run test:pg`): the user's version and
 * its `rev`, tombstones, the shared version other users see, the changes feed of the user's devices and
 * `lyrics.changed` reaching every device but the author.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { LiveEvent } from "../../contract/live.ts";
import type { LyricsResponse, MyLyrics, MyLyricsPage } from "../../contract/lyrics.ts";
import type { AppContext } from "../../context.ts";
import { bearer, createAccount, createDevice, createSession } from "../../test/factories.ts";
import type { TestAccount } from "../../test/factories.ts";
import { assertError, createTestApp, json } from "../../test/test-app.ts";
import type { TestApp } from "../../test/test-app.ts";

const VIDEO = "dQw4w9WgXcQ";
const OTHER_VIDEO = "a1B2c3D4e5F";
/** `lyrics.changed` coalesces per user for 2 s of real time; tests that expect two events in a row wait it out. */
const COALESCE_WINDOW_MS = 2100;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const LRC = "[00:12.30]Я вернусь\n[00:15.80]Когда растает снег";
const PLAIN = "Я вернусь\nКогда растает снег";

function watch(ctx: AppContext, userId: string, deviceId: string) {
  const events: LiveEvent[] = [];
  const registration = ctx.live.register({
    userId,
    deviceId,
    authVersion: 1,
    expiresAt: Number.MAX_SAFE_INTEGER,
    send: (event) => events.push(event),
    close: () => undefined,
  });
  return { events, unregister: registration.unregister };
}

async function secondDevice(t: TestApp, userId: string) {
  const device = await createDevice(t.db, userId, { now: t.clock.now(), name: "ThinkPad" });
  const session = await createSession(t.ctx, { userId, deviceId: device.id, now: t.clock.now() });
  return { device, session };
}

let t: TestApp;

before(async () => {
  t = await createTestApp();
});
after(() => t.close());

function auth(account: TestAccount) {
  return bearer(account.session.tokens.accessToken);
}

async function put(account: TestAccount, videoId: string, body: Record<string, unknown>) {
  return t.app.inject({ method: "PUT", url: `/lyrics/${videoId}`, headers: auth(account), payload: body });
}

async function get(account: TestAccount, videoId: string): Promise<LyricsResponse> {
  const response = await t.app.inject({ method: "GET", url: `/lyrics/${videoId}`, headers: auth(account) });
  assert.equal(response.statusCode, 200);
  return json(response) as unknown as LyricsResponse;
}

async function changes(account: TestAccount, body: Record<string, unknown>): Promise<MyLyricsPage> {
  const response = await t.app.inject({
    method: "POST",
    url: "/auth/me/lyrics/changes",
    headers: auth(account),
    payload: body,
  });
  assert.equal(response.statusCode, 200, response.body);
  return json(response) as unknown as MyLyricsPage;
}

async function remove(account: TestAccount, videoId: string): Promise<void> {
  const response = await t.app.inject({ method: "DELETE", url: `/lyrics/${videoId}`, headers: auth(account) });
  assert.equal(response.statusCode, 204);
}

describe("PUT /lyrics/{videoId}", () => {
  test("creates the version: rev 1, GET shows it as mine, the other device gets lyrics.changed", async () => {
    const account = await createAccount(t.ctx);
    const other = await secondDevice(t, account.user.id);
    const otherWatcher = watch(t.ctx, account.user.id, other.device.id);
    const authorWatcher = watch(t.ctx, account.user.id, account.device.id);

    const response = await put(account, VIDEO, {
      plain: PLAIN,
      plainSource: "lrclib",
      synced: LRC,
      syncedFormat: "lrc",
      syncedSource: "user",
      language: "ru",
    });
    assert.equal(response.statusCode, 200, response.body);
    const mine = json(response) as unknown as MyLyrics;
    assert.equal(mine.videoId, VIDEO);
    assert.equal(mine.rev, 1);
    assert.equal(mine.deleted, false);
    assert.deepEqual(mine.text, {
      plain: PLAIN,
      plainSource: "lrclib",
      synced: LRC,
      syncedFormat: "lrc",
      syncedSource: "user",
      startTimeMs: null,
      language: "ru",
    });

    const read = await get(account, VIDEO);
    assert.deepEqual(read.mine, mine);
    assert.equal(read.shared, null, "the caller's own version is never shared back to them");

    assert.deepEqual(
      otherWatcher.events.map((event) => [event.type, event.payload]),
      [["lyrics.changed", { videoId: VIDEO, rev: 1 }]],
    );
    assert.deepEqual(authorWatcher.events, []);
    otherWatcher.unregister();
    authorWatcher.unregister();
  });

  test("the same content again keeps rev and sends no event; a change bumps rev and keeps the id", async () => {
    const account = await createAccount(t.ctx);
    const other = await secondDevice(t, account.user.id);
    const first = json(await put(account, VIDEO, { plain: PLAIN, plainSource: "user" })) as unknown as MyLyrics;

    await sleep(COALESCE_WINDOW_MS);
    const watcher = watch(t.ctx, account.user.id, other.device.id);
    const again = json(await put(account, VIDEO, { plain: PLAIN, plainSource: "user" })) as unknown as MyLyrics;
    assert.deepEqual(again, first);
    assert.equal(watcher.events.length, 0);

    t.clock.advance(1000);
    const changed = json(
      await put(account, VIDEO, { plain: PLAIN, plainSource: "user", synced: LRC, syncedFormat: "lrc" }),
    ) as unknown as MyLyrics;
    assert.equal(changed.id, first.id);
    assert.equal(changed.rev, 2);
    assert.equal(changed.text?.syncedSource, null, "a text without a source is stored with null");
    assert.notEqual(changed.updatedAt, first.updatedAt);
    assert.deepEqual(
      watcher.events.map((event) => event.payload),
      [{ videoId: VIDEO, rev: 2 }],
    );
    watcher.unregister();
  });

  test("rev counts every change of the user across videos; other users count on their own", async () => {
    const one = await createAccount(t.ctx);
    const two = await createAccount(t.ctx);
    assert.equal((json(await put(one, VIDEO, { plain: "a" })) as unknown as MyLyrics).rev, 1);
    assert.equal((json(await put(one, OTHER_VIDEO, { plain: "b" })) as unknown as MyLyrics).rev, 2);
    assert.equal((json(await put(two, VIDEO, { plain: "c" })) as unknown as MyLyrics).rev, 1);
    assert.equal((json(await put(one, VIDEO, { plain: "d" })) as unknown as MyLyrics).rev, 3);
  });

  test("a source without the text of its side is dropped", async () => {
    const account = await createAccount(t.ctx);
    const mine = json(
      await put(account, VIDEO, { plain: PLAIN, syncedSource: "user", startTimeMs: 4200 }),
    ) as unknown as MyLyrics;
    assert.ok(mine.text);
    assert.equal(mine.text.syncedSource, null);
    assert.equal(mine.text.startTimeMs, 4200);
  });

  test("validation: plain or synced, syncedFormat exactly with synced, known values, lengths, video id", async () => {
    const account = await createAccount(t.ctx);
    assertError(await put(account, VIDEO, {}), 400, "invalid_request");
    assertError(await put(account, VIDEO, { plainSource: "user" }), 400, "invalid_request");
    assertError(await put(account, VIDEO, { synced: LRC }), 400, "invalid_request");
    assertError(await put(account, VIDEO, { plain: PLAIN, syncedFormat: "lrc" }), 400, "invalid_request");
    assertError(await put(account, VIDEO, { synced: LRC, syncedFormat: "srt" }), 400, "invalid_request");
    assertError(await put(account, VIDEO, { plain: PLAIN, plainSource: "genius" }), 400, "invalid_request");
    assertError(await put(account, VIDEO, { plain: "" }), 400, "invalid_request");
    assertError(await put(account, VIDEO, { plain: "x".repeat(50_001) }), 400, "invalid_request");
    assertError(await put(account, VIDEO, { plain: PLAIN, startTimeMs: -1 }), 400, "invalid_request");
    assertError(await put(account, "short", { plain: PLAIN }), 400, "invalid_request");
    // null is "absent" (API §1.3)
    const response = await put(account, VIDEO, { plain: PLAIN, synced: null, syncedFormat: null });
    assert.equal(response.statusCode, 200, response.body);
  });

  test("the body may be up to 1 MiB: 200 000 Cyrillic characters of synced lyrics fit, more is 413", async () => {
    const account = await createAccount(t.ctx);
    const synced = "ж".repeat(200_000);
    const response = await put(account, VIDEO, { synced, syncedFormat: "ttml" });
    assert.equal(response.statusCode, 200, response.body.slice(0, 200));
    assertError(await put(account, VIDEO, { plain: "ж".repeat(600_000) }), 413, "payload_too_large");
  });

  test("needs a Bearer token", async () => {
    const response = await t.app.inject({ method: "PUT", url: `/lyrics/${VIDEO}`, payload: { plain: PLAIN } });
    assertError(response, 401, "unauthorized");
  });
});

describe("DELETE /lyrics/{videoId}", () => {
  test("writes a tombstone once; GET has no mine; the other device gets lyrics.changed", async () => {
    const account = await createAccount(t.ctx);
    const other = await secondDevice(t, account.user.id);
    await put(account, VIDEO, { plain: PLAIN });
    await sleep(COALESCE_WINDOW_MS);
    const watcher = watch(t.ctx, account.user.id, other.device.id);

    await remove(account, VIDEO);
    assert.equal((await get(account, VIDEO)).mine, null);
    assert.deepEqual(
      watcher.events.map((event) => event.payload),
      [{ videoId: VIDEO, rev: 2 }],
    );

    await sleep(COALESCE_WINDOW_MS);
    await remove(account, VIDEO);
    await remove(account, OTHER_VIDEO);
    assert.equal(watcher.events.length, 1, "nothing to delete: no change, no event");
    watcher.unregister();

    const page = await changes(account, { after: 1 });
    assert.deepEqual(
      page.items.map((item) => [item.videoId, item.rev, item.deleted, item.text]),
      [[VIDEO, 2, true, null]],
    );

    const back = json(await put(account, VIDEO, { plain: "снова" })) as unknown as MyLyrics;
    assert.equal(back.rev, 3);
    assert.equal(back.deleted, false);
  });
});

describe("GET /lyrics/{videoId}: shared", () => {
  test("another user's version, synced before plain, the most recent; never a tombstone", async () => {
    const plainAuthor = await createAccount(t.ctx);
    const syncedAuthor = await createAccount(t.ctx);
    const newerSyncedAuthor = await createAccount(t.ctx);
    const reader = await createAccount(t.ctx);
    const video = "Zx9Yw8Vu7Ts";

    assert.equal((await get(reader, video)).shared, null);

    await put(plainAuthor, video, { plain: PLAIN });
    let shared = (await get(reader, video)).shared;
    assert.equal(shared?.text.plain, PLAIN);
    assert.equal(shared.text.synced, null);

    t.clock.advance(1000);
    await put(syncedAuthor, video, { synced: LRC, syncedFormat: "lrc", syncedSource: "user" });
    t.clock.advance(1000);
    await put(plainAuthor, video, { plain: `${PLAIN}!` });
    shared = (await get(reader, video)).shared;
    assert.equal(shared?.text.synced, LRC, "synced lyrics win over a newer plain-only version");

    t.clock.advance(1000);
    await put(newerSyncedAuthor, video, { synced: `${LRC}\n[00:20.00]…`, syncedFormat: "lrc" });
    shared = (await get(reader, video)).shared;
    assert.equal(shared?.text.synced, `${LRC}\n[00:20.00]…`);
    assert.equal(Object.hasOwn(shared, "rev"), false, "the author's counter is not disclosed");

    await remove(newerSyncedAuthor, video);
    assert.equal((await get(reader, video)).shared?.text.synced, LRC);
    assert.equal((await get(syncedAuthor, video)).shared?.text.plain, `${PLAIN}!`, "never your own version");
  });
});

describe("POST /auth/me/lyrics/changes", () => {
  test("pages by rev; the first load skips tombstones and returns the latest rev", async () => {
    const account = await createAccount(t.ctx);
    const videos = ["v0000000001", "v0000000002", "v0000000003"];
    for (const video of videos) await put(account, video, { plain: video });
    await remove(account, videos[1] ?? "");

    const first = await changes(account, { after: 0 });
    assert.deepEqual(
      first.items.map((item) => [item.videoId, item.rev]),
      [
        [videos[0], 1],
        [videos[2], 3],
      ],
    );
    assert.equal(first.rev, 4, "after all tombstones");
    assert.equal(first.more, false);

    const paged = await changes(account, { after: 0, limit: 1 });
    assert.deepEqual(
      paged.items.map((item) => item.rev),
      [1],
    );
    assert.equal(paged.more, true);
    assert.equal(paged.rev, 1);
    // The tombstone moved the second video to rev 4: its row keeps one place in the feed, the newest
    const rest = await changes(account, { after: paged.rev, limit: 1 });
    assert.deepEqual(
      rest.items.map((item) => [item.rev, item.deleted]),
      [[3, false]],
    );
    assert.equal(rest.more, true);
    const tombstone = await changes(account, { after: rest.rev });
    assert.deepEqual(
      tombstone.items.map((item) => [item.videoId, item.rev, item.deleted]),
      [[videos[1], 4, true]],
    );
    assert.equal(tombstone.more, false);

    const nothing = await changes(account, { after: 4 });
    assert.deepEqual(nothing, { items: [], rev: 4, more: false });

    const empty = await changes(await createAccount(t.ctx), { after: 0 });
    assert.deepEqual(empty, { items: [], rev: 0, more: false });
  });

  test("validation", async () => {
    const account = await createAccount(t.ctx);
    const bad = async (payload: Record<string, unknown>) =>
      t.app.inject({ method: "POST", url: "/auth/me/lyrics/changes", headers: auth(account), payload });
    assertError(await bad({}), 400, "invalid_request");
    assertError(await bad({ after: -1 }), 400, "invalid_request");
    assertError(await bad({ after: 0, limit: 0 }), 400, "invalid_request");
    assertError(await bad({ after: 0, limit: 201 }), 400, "invalid_request");
  });
});

describe("/server/info", () => {
  test("declares features.lyrics", async () => {
    const response = await t.app.inject({ method: "GET", url: "/server/info" });
    const features = json(response).features as Record<string, unknown>;
    assert.deepEqual(features.lyrics, { version: 1 });
  });
});
