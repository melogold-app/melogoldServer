/**
 * `POST /sync` core mechanics on both dialects (DESIGN §3.8 "Алгоритм POST /sync", §3.6 "Курсор и потоки"; PLAN
 * T2.1 Приёмка "sync-core.int"):
 * - идемпотентность: a repeated `opId` answers the same result with `replayed: true`, and spends no new `seq`;
 * - a no-op (the value is already there) is `applied` but spends no `seq` either (the head does not move);
 * - the page splits its budget between `library` and `history` (`readPage`), `hasMore` and pagination continue
 *   correctly;
 * - satellites (`readSatellites`): a parent playlist newer than the page, tracks of present items and liked likes;
 * - every key of the response appears once, even when `touched` and `include` name it twice.
 *
 * `library` rows come from the real `like.set`/`bookmark.set` handlers this task owns. `history`, playlist and item
 * rows that DESIGN assigns to other tasks (T2.2, T2.3) are seeded directly (through `lockUser`/`bumpHead`, exactly
 * as their future handlers will write them) so that `page.ts`'s generic, stream-agnostic logic can be exercised now.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { LightMyRequestResponse } from "fastify";
import { toDbBool } from "../../db/codecs.ts";
import { bumpHead, lockUser } from "../../db/heads.ts";
import type { Queryable } from "../../db/index.ts";
import { newId } from "../../lib/ids.ts";
import { bearer, createAccount, createDevice, createSession, createUser } from "../../test/factories.ts";
import type { TestAccount } from "../../test/factories.ts";
import { createTestApp, json } from "../../test/test-app.ts";
import type { TestApp } from "../../test/test-app.ts";

let t: TestApp;

before(async () => {
  t = await createTestApp();
});

after(async () => {
  await t.close();
});

/** An 11-character VideoId, distinct per `n`. */
function vid(n: number): string {
  return `v${String(n).padStart(10, "0")}`;
}

type SyncBody = Readonly<{
  cursor: string;
  limit?: number;
  streams?: readonly string[];
  ops?: readonly Record<string, unknown>[];
  include?: Record<string, unknown>;
}>;

function postSync(token: string, body: SyncBody): Promise<LightMyRequestResponse> {
  return t.app.inject({
    method: "POST",
    url: "/sync",
    headers: { ...bearer(token), "x-sync-protocol": "1", "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
}

function likeOp(videoId: string, liked: boolean, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { opId: newId(), kind: "like.set", at: new Date(t.clock.now()).toISOString(), videoId, liked, ...extra };
}

/** Allocates the next `seq` under `lockUser` and writes a row with it, exactly as a real handler would. */
async function withNextSeq(userId: string, write: (q: Queryable, seq: number) => Promise<unknown>): Promise<number> {
  return t.db.write(async (q) => {
    const head = await lockUser(q, userId);
    const seq = head.seq + 1;
    await write(q, seq);
    await bumpHead(q, userId, seq, t.clock.now());
    return seq;
  });
}

async function seedPlayEvent(userId: string, videoId: string, playedAt: number): Promise<number> {
  return withNextSeq(userId, (q, seq) =>
    q
      .insertInto("play_events")
      .values({
        user_id: userId,
        event_id: newId(),
        video_id: videoId,
        played_at: playedAt,
        play_time_ms: 10_000,
        in_history: 1,
        counts_playtime: 1,
        device_id: null,
        seq,
        received_at: playedAt,
      })
      .execute(),
  );
}

async function seedPlaylist(userId: string, id: string, seq: number, now: number): Promise<void> {
  await t.db.write((q) =>
    q
      .insertInto("sync_playlists")
      .values({
        user_id: userId,
        id,
        name: "Родитель",
        browse_id: null,
        thumbnail_url: null,
        created_at: now,
        deleted: 0,
        deleted_at: null,
        deleted_seq: null,
        item_count: 1,
        seq,
        clk_at: now,
        clk_dev: null,
      })
      .execute(),
  );
}

async function seedPlaylistItem(userId: string, playlistId: string, videoId: string, seq: number): Promise<void> {
  const now = t.clock.now();
  await t.db.write((q) =>
    q
      .insertInto("sync_playlist_items")
      .values({
        user_id: userId,
        playlist_id: playlistId,
        video_id: videoId,
        present: 1,
        sort_key: "a0",
        added_at: now,
        seq,
        mem_seq: seq,
        mem_at: now,
        mem_dev: null,
        pos_seq: seq,
        pos_at: now,
        pos_dev: null,
      })
      .execute(),
  );
}

/** Moves the head to (at least) `seq`, for rows seeded with an explicit `seq` outside {@link withNextSeq}. */
async function bumpHeadTo(userId: string, seq: number): Promise<void> {
  await t.db.write(async (q) => {
    const head = await lockUser(q, userId);
    if (seq > head.seq) await bumpHead(q, userId, seq, t.clock.now());
  });
}

async function seedLike(userId: string, videoId: string, seq: number): Promise<void> {
  const now = t.clock.now();
  await t.db.write((q) =>
    q
      .insertInto("sync_likes")
      .values({ user_id: userId, video_id: videoId, liked: 1, liked_at: now, seq, clk_at: now, clk_dev: null })
      .execute(),
  );
}

describe("идемпотентность: replayed", () => {
  let account: TestAccount;

  before(async () => {
    account = await createAccount(t.ctx);
  });

  test("a repeated opId answers the same result, replayed:true, and spends no new seq", async () => {
    const token = account.session.tokens.accessToken;
    const op = likeOp(vid(1), true);
    const first = json(await postSync(token, { cursor: "", ops: [op] }));
    const firstResult = (first.results as Record<string, unknown>[])[0];
    assert.equal(firstResult?.status, "applied");
    assert.equal(firstResult.replayed, false);
    assert.ok(typeof firstResult.seq === "number");

    const second = json(await postSync(token, { cursor: String(first.cursor), ops: [op] }));
    const secondResult = (second.results as Record<string, unknown>[])[0];
    assert.deepEqual(secondResult, { ...firstResult, replayed: true });
    // No seq was spent replaying: the head (and so the cursor) did not move.
    assert.equal(second.cursor, first.cursor);
  });

  test("a replay is per-user, not per-device: another device of the same user sees it too", async () => {
    const device = await createDevice(t.db, account.user.id);
    const session = await createSession(t.ctx, { userId: account.user.id, deviceId: device.id });
    const op = likeOp(vid(2), true);
    const first = json(await postSync(account.session.tokens.accessToken, { cursor: "", ops: [op] }));
    const second = json(await postSync(session.tokens.accessToken, { cursor: "", ops: [op] }));
    const firstResult = (first.results as Record<string, unknown>[])[0];
    const secondResult = (second.results as Record<string, unknown>[])[0];
    assert.equal(secondResult?.replayed, true);
    assert.equal(secondResult.seq, firstResult?.seq);
  });

  test("play.add (idempotent by play_events, not sync_ops) goes through /sync: applied, then replayed", async () => {
    const now = new Date(t.clock.now()).toISOString();
    const op = {
      opId: newId(),
      kind: "play.add",
      at: now,
      videoId: vid(3),
      playedAt: now,
      playTimeMs: 180_000,
      history: true,
      playtime: true,
    };
    const token = account.session.tokens.accessToken;
    const first = (json(await postSync(token, { cursor: "", ops: [op] })).results as Record<string, unknown>[])[0];
    assert.equal(first?.status, "applied");
    const again = (json(await postSync(token, { cursor: "", ops: [op] })).results as Record<string, unknown>[])[0];
    assert.equal(again?.status, "applied");
    assert.equal(again.replayed, true);
  });
});

describe("холостая операция не тратит seq", () => {
  test("liking an already-liked video a second time (different opId) is applied but spends no seq", async () => {
    const account = await createAccount(t.ctx);
    const token = account.session.tokens.accessToken;
    const first = json(await postSync(token, { cursor: "", ops: [likeOp(vid(4), true)] }));
    assert.equal((first.results as Record<string, unknown>[])[0]?.status, "applied");

    const second = json(await postSync(token, { cursor: String(first.cursor), ops: [likeOp(vid(4), true)] }));
    const secondResult = (second.results as Record<string, unknown>[])[0];
    assert.equal(secondResult?.status, "applied");
    assert.equal(secondResult.seq, null, "a no-op never reports a seq");
    assert.equal(secondResult.replayed, false, "a different opId is not a replay");
    // The head did not move: pulling from the head before and after gives the same cursor.
    assert.equal(second.cursor, first.cursor);
  });

  test("a losing op (superseded) also spends no seq", async () => {
    const account = await createAccount(t.ctx);
    const token = account.session.tokens.accessToken;
    const other = await createDevice(t.db, account.user.id, { id: newId() });
    const otherSession = await createSession(t.ctx, { userId: account.user.id, deviceId: other.id });

    const now = t.clock.now();
    const liked = json(
      await postSync(token, {
        cursor: "",
        ops: [likeOp(vid(5), true, { at: new Date(now).toISOString() })],
      }),
    );
    assert.equal((liked.results as Record<string, unknown>[])[0]?.status, "applied");

    // An older, no-base unlike from another device loses the register (effAt < reg.at) → superseded, no seq.
    const stale = json(
      await postSync(otherSession.tokens.accessToken, {
        cursor: "",
        ops: [likeOp(vid(5), false, { at: new Date(now - 60_000).toISOString() })],
      }),
    );
    const staleResult = (stale.results as Record<string, unknown>[])[0];
    assert.equal(staleResult?.status, "superseded");
    assert.equal(staleResult.seq, null);
    assert.equal(stale.cursor, liked.cursor);
  });
});

describe("страница делится между library и history; hasMore", () => {
  test("library takes up to limit, history gets the rest of the budget; both continue correctly", async () => {
    const user = await createUser(t.db, { now: t.clock.now() });
    const device = await createDevice(t.db, user.id);
    const session = await createSession(t.ctx, { userId: user.id, deviceId: device.id });
    const token = session.tokens.accessToken;

    // 2 library rows (likes), 5 history rows (play_events), seq allocated as real handlers would.
    await seedLike(user.id, vid(10), await withNextSeq(user.id, () => Promise.resolve()));
    await seedLike(user.id, vid(11), await withNextSeq(user.id, () => Promise.resolve()));
    for (let i = 0; i < 5; i++) await seedPlayEvent(user.id, vid(20 + i), t.clock.now() + i);

    const page1 = json(await postSync(token, { cursor: "", limit: 4, ops: [] }));
    assert.equal((page1.likes as unknown[]).length, 2, "library is exhausted: both likes fit");
    assert.equal((page1.plays as unknown[]).length, 2, "the 2 remaining budget slots go to history");
    assert.equal(page1.hasMore, true, "3 history rows are still unread");

    const page2 = json(await postSync(token, { cursor: String(page1.cursor), limit: 4, ops: [] }));
    assert.equal((page2.likes as unknown[]).length, 0, "library was already at its head");
    assert.equal((page2.plays as unknown[]).length, 3, "the remaining history rows");
    assert.equal(page2.hasMore, false);

    const page3 = json(await postSync(token, { cursor: String(page2.cursor), limit: 4, ops: [] }));
    assert.equal(page3.hasMore, false);
    assert.equal((page3.likes as unknown[]).length, 0);
    assert.equal((page3.plays as unknown[]).length, 0);
    assert.equal(page3.cursor, page2.cursor, "a pull at the head is a no-op and does not touch the tables");
  });

  test("streams: requesting only history never blocks on an unread library, and vice versa", async () => {
    const user = await createUser(t.db, { now: t.clock.now() });
    const device = await createDevice(t.db, user.id);
    const session = await createSession(t.ctx, { userId: user.id, deviceId: device.id });
    const token = session.tokens.accessToken;
    await seedLike(user.id, vid(30), await withNextSeq(user.id, () => Promise.resolve()));
    await seedPlayEvent(user.id, vid(31), t.clock.now());

    const historyOnly = json(await postSync(token, { cursor: "", streams: ["history"], ops: [] }));
    assert.equal((historyOnly.likes as unknown[]).length, 0);
    assert.equal((historyOnly.plays as unknown[]).length, 1);
    assert.equal(historyOnly.hasMore, false, "the unread library row is not part of the requested streams");

    const libraryOnly = json(await postSync(token, { cursor: "", streams: ["library"], ops: [] }));
    assert.equal((libraryOnly.likes as unknown[]).length, 1);
    assert.equal((libraryOnly.plays as unknown[]).length, 0);
    assert.equal(libraryOnly.hasMore, false);
  });
});

describe("satellites (DESIGN §3.8 «Состав ответа»)", () => {
  test("a parent playlist newer than the page is included even though it did not fit on the page", async () => {
    const user = await createUser(t.db, { now: t.clock.now() });
    const device = await createDevice(t.db, user.id);
    const session = await createSession(t.ctx, { userId: user.id, deviceId: device.id });
    const token = session.tokens.accessToken;
    const playlistId = newId();

    // The item's own seq is small; the playlist header's seq is much larger (created "later" than the item was
    // last touched, e.g. a title update) — a limit of 1 pages in only the item. The playlist row must exist first
    // (the item's foreign key), even though its seq is allocated "later" in the stream's timeline.
    await seedPlaylist(user.id, playlistId, 100, t.clock.now());
    await seedPlaylistItem(user.id, playlistId, vid(40), 1);
    await bumpHeadTo(user.id, 100);

    const response = json(await postSync(token, { cursor: "", limit: 1, ops: [] }));
    const items = response.items as { playlistId: string; videoId: string }[];
    assert.equal(items.length, 1);
    assert.equal(items[0]?.playlistId, playlistId);
    const playlists = response.playlists as { id: string }[];
    assert.equal(playlists.length, 1, "the parent is fetched even though its own seq (100) is past the page (1)");
    assert.equal(playlists[0]?.id, playlistId);
  });

  test("tracks[] on a winning like.set creates the track row and it satellites into the response", async () => {
    const account = await createAccount(t.ctx);
    const token = account.session.tokens.accessToken;
    const videoId = vid(50);
    const op = likeOp(videoId, true, {
      tracks: [{ videoId, title: "Дорога", artistsText: "Кино", durationMs: 210_000 }],
    });
    const response = json(await postSync(token, { cursor: "", ops: [op] }));
    const tracks = response.tracks as { videoId: string; title: string; metadataStub: boolean }[];
    assert.equal(tracks.length, 1);
    assert.equal(tracks[0]?.videoId, videoId);
    assert.equal(tracks[0].title, "Дорога");
    assert.equal(tracks[0].metadataStub, false);
  });

  test("a track older than the page still satellites in when its video gets liked on the page", async () => {
    const user = await createUser(t.db, { now: t.clock.now() });
    const device = await createDevice(t.db, user.id);
    const session = await createSession(t.ctx, { userId: user.id, deviceId: device.id });
    const token = session.tokens.accessToken;
    const videoId = vid(51);

    const trackSeq = await withNextSeq(user.id, (q, seq) =>
      q
        .insertInto("sync_tracks")
        .values({
          user_id: user.id,
          video_id: videoId,
          title: "Заглушка",
          artists_text: null,
          artists: null,
          album_id: null,
          album_title: null,
          duration_ms: null,
          duration_text: null,
          thumbnail_url: null,
          explicit: toDbBool(false),
          video_type: null,
          stub: toDbBool(false),
          seq,
          updated_at: t.clock.now(),
        })
        .execute(),
    );
    // A first pull reads the track (nothing else exists yet) and moves the client's cursor past it.
    const before = json(await postSync(token, { cursor: "", ops: [] }));
    assert.equal((before.tracks as unknown[]).length, 1);
    assert.equal(before.hasMore, false);
    // Both streams read up to the head: the (empty) history stream is trivially exhausted too.
    assert.equal(before.cursor, `${(before.cursor as string).split(".")[0]}.${trackSeq}.${trackSeq}`);

    await seedLike(user.id, videoId, await withNextSeq(user.id, () => Promise.resolve()));
    const after = json(await postSync(token, { cursor: before.cursor, ops: [] }));
    const likes = after.likes as { videoId: string; liked: boolean }[];
    assert.equal(likes.length, 1);
    assert.equal(likes[0]?.liked, true);
    const tracks = after.tracks as { videoId: string }[];
    assert.equal(tracks.length, 1, "the track's own seq is older than `since`, but it satellites via the like");
    assert.equal(tracks[0]?.videoId, videoId);
  });
});

describe("каждый ключ один раз", () => {
  test("a key named by both touched and include appears exactly once in its array", async () => {
    const account = await createAccount(t.ctx);
    const token = account.session.tokens.accessToken;
    const videoId = vid(60);
    const op = likeOp(videoId, true);
    const response = json(await postSync(token, { cursor: "", ops: [op], include: { likes: [videoId] } }));
    const likes = response.likes as { videoId: string }[];
    assert.equal(likes.length, 1);
    assert.equal(likes[0]?.videoId, videoId);
  });

  test("two ops touching the same key (like, then unlike) leave exactly one row for that key", async () => {
    const account = await createAccount(t.ctx);
    const token = account.session.tokens.accessToken;
    const videoId = vid(61);
    const response = json(
      await postSync(token, {
        cursor: "",
        ops: [likeOp(videoId, true, { at: new Date(t.clock.now()).toISOString() }), likeOp(videoId, false)],
      }),
    );
    const likes = response.likes as { videoId: string; liked: boolean }[];
    assert.equal(likes.length, 1);
    assert.equal(likes[0]?.liked, false, "the response carries the final image, not an entry per op");
  });
});
