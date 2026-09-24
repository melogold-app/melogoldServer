/**
 * `GET /auth/me/export` (API §4.5, DESIGN §4.11), both dialects (PLAN T1.3 `export.int`):
 * - structure matches `ExportDocument` (API §4.5): only what the user owns and sees (liked, bookmarked, live
 *   playlists with present items, history plays, totals, watermarks), tombstones and other users' rows excluded;
 * - no secrets: no password or recovery code hash, no token, no hwid (not even its hash);
 * - keyset paging assembles a full, correctly ordered array across several pages;
 * - the account gone since the guard ran → `session_revoked`;
 * - 3 requests per hour per user (API §4.5, `route-policy.ts`).
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { ExportDocument } from "../../contract/account.ts";
import { HOUR_MS } from "../../lib/clock.ts";
import { newId } from "../../lib/ids.ts";
import { formatIso } from "../../lib/time.ts";
import { bearer, createAccount, createDevice } from "../../test/factories.ts";
import type { TestAccount } from "../../test/factories.ts";
import { assertError, createTestApp, json } from "../../test/test-app.ts";
import type { TestApp } from "../../test/test-app.ts";
import type { RequestAuth } from "../../http/auth-guard.ts";
import { prepareExport } from "./export.ts";

let t: TestApp;

before(async () => {
  t = await createTestApp();
});

after(async () => {
  await t.close();
});

function requestAuth(account: TestAccount): RequestAuth {
  const now = t.clock.now();
  return {
    userId: account.user.id,
    deviceId: account.device.id,
    authVersion: account.user.authVersion,
    refreshId: newId(),
    tokenIssuedAt: now,
    tokenExpiresAt: now + HOUR_MS,
  };
}

function get(token: string) {
  return t.app.inject({ method: "GET", url: "/auth/me/export", headers: bearer(token) });
}

/** A full row of every library/history table, split into what the export must include and what it must not. */
async function seedLibrary(userId: string): Promise<{ included: Record<string, unknown>; excludedVideoIds: string[] }> {
  const now = t.clock.now();
  const playlistId = newId();
  const deletedPlaylistId = newId();
  await t.db.write(async (q) => {
    await q
      .insertInto("sync_tracks")
      .values([
        {
          user_id: userId,
          video_id: "vidTRACKone",
          title: "First Track",
          artists_text: "Some Artist",
          artists: JSON.stringify([{ id: "UCabcdefghijklmnopqrstuv", name: "Some Artist" }]),
          album_id: null,
          album_title: null,
          duration_ms: 200_000,
          duration_text: "3:20",
          thumbnail_url: "https://example.com/thumb.jpg",
          video_type: "song",
          stub: 0,
          seq: 1,
          updated_at: now,
        },
        {
          user_id: userId,
          video_id: "vidTRACKtwo",
          title: "vidTRACKtwo",
          artists_text: null,
          artists: null,
          album_id: null,
          album_title: null,
          duration_ms: null,
          duration_text: null,
          thumbnail_url: null,
          video_type: null,
          stub: 1,
          seq: 2,
          updated_at: now,
        },
      ])
      .execute();

    await q
      .insertInto("sync_likes")
      .values([
        { user_id: userId, video_id: "vidLIKEDone", liked: 1, liked_at: now, seq: 1, clk_at: now, clk_dev: null },
        {
          user_id: userId,
          video_id: "vidUNLIKEDx",
          liked: 0,
          liked_at: null,
          seq: 2,
          clk_at: now,
          clk_dev: null,
        },
      ])
      .execute();

    await q
      .insertInto("sync_bookmarks")
      .values([
        {
          user_id: userId,
          type: "album",
          browse_id: "MPREb_marked01",
          bookmarked: 1,
          bookmarked_at: now,
          title: "Marked Album",
          subtitle: "An artist",
          thumbnail_url: null,
          year: "2024",
          seq: 1,
          clk_at: now,
          clk_dev: null,
        },
        {
          user_id: userId,
          type: "artist",
          browse_id: "UCunmarked000000000000",
          bookmarked: 0,
          bookmarked_at: null,
          title: null,
          subtitle: null,
          thumbnail_url: null,
          year: null,
          seq: 2,
          clk_at: now,
          clk_dev: null,
        },
      ])
      .execute();

    await q
      .insertInto("sync_playlists")
      .values([
        {
          user_id: userId,
          id: playlistId,
          name: "Дорога",
          browse_id: null,
          thumbnail_url: null,
          created_at: now,
          deleted: 0,
          deleted_at: null,
          deleted_seq: null,
          seq: 1,
          clk_at: now,
          clk_dev: null,
        },
        {
          user_id: userId,
          id: deletedPlaylistId,
          name: "Удалённый плейлист",
          browse_id: null,
          thumbnail_url: null,
          created_at: now,
          deleted: 1,
          deleted_at: now,
          deleted_seq: 99,
          seq: 2,
          clk_at: now,
          clk_dev: null,
        },
      ])
      .execute();

    await q
      .insertInto("sync_playlist_items")
      .values([
        {
          user_id: userId,
          playlist_id: playlistId,
          video_id: "vidPRESENTx",
          present: 1,
          sort_key: "m",
          added_at: now,
          seq: 1,
          mem_seq: 1,
          mem_at: now,
          mem_dev: null,
          pos_seq: 1,
          pos_at: now,
          pos_dev: null,
        },
        {
          user_id: userId,
          playlist_id: playlistId,
          video_id: "vidREMOVEDx",
          present: 0,
          sort_key: "z",
          added_at: now,
          seq: 2,
          mem_seq: 2,
          mem_at: now,
          mem_dev: null,
          pos_seq: 2,
          pos_at: now,
          pos_dev: null,
        },
      ])
      .execute();

    await q
      .insertInto("play_events")
      .values([
        {
          user_id: userId,
          event_id: newId(),
          video_id: "vidHISTORYx",
          played_at: now,
          play_time_ms: 120_000,
          in_history: 1,
          counts_playtime: 1,
          device_id: null,
          seq: 1,
          received_at: now,
        },
        {
          user_id: userId,
          event_id: newId(),
          video_id: "vidFORGOTTx",
          played_at: now,
          play_time_ms: 5_000,
          in_history: 0,
          counts_playtime: 0,
          device_id: null,
          seq: null,
          received_at: now,
        },
      ])
      .execute();

    await q
      .insertInto("play_stats")
      .values({ user_id: userId, video_id: "vidHISTORYx", total_ms: 120_000, last_played_at: now, seq: 1 })
      .execute();

    await q
      .insertInto("play_forgets")
      .values({ user_id: userId, video_id: "*", events_before: now, total_before: now, seq: 1 })
      .execute();

    await q
      .insertInto("playback_state")
      .values({
        user_id: userId,
        rev: 1,
        cleared: 0,
        device_id: newId(),
        device_name: "Google Pixel 8",
        session_id: newId(),
        queue_version: 1,
        queue: JSON.stringify([
          {
            videoId: "vidPRESENTx",
            title: "Present Track",
            artistsText: null,
            artists: [],
            albumId: null,
            albumTitle: null,
            durationMs: null,
            durationText: null,
            thumbnailUrl: null,
            explicit: false,
            videoType: null,
            metadataStub: false,
          },
        ]),
        idx: 0,
        position_ms: 1000,
        duration_ms: null,
        playing: 0,
        state_at: now,
        updated_at: now,
        handoff_device_id: null,
        handoff_session_id: null,
        handoff_at: null,
      })
      .execute();
  });

  return {
    included: { playlistId },
    excludedVideoIds: ["vidUNLIKEDx", "vidREMOVEDx", "vidFORGOTTx"],
  };
}

describe("GET /auth/me/export", () => {
  test("structure matches ExportDocument; only owned/live/visible rows; no secrets", async () => {
    const account = await createAccount(t.ctx);
    const second = await createDevice(t.db, account.user.id, {
      hwid: "9".repeat(64),
      name: "Второе устройство",
      linkedVia: "link",
      now: t.clock.now(),
    });
    const seed = await seedLibrary(account.user.id);

    const response = await get(account.session.tokens.accessToken);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers["content-type"], "application/json; charset=utf-8");
    assert.match(
      String(response.headers["content-disposition"]),
      new RegExp(`^attachment; filename="melogold-export-${account.user.login}-\\d{4}-\\d{2}-\\d{2}\\.json"$`),
    );

    const body = json(response);
    const doc = ExportDocument.parse(body);

    assert.equal(doc.format, "melogold-export");
    assert.equal(doc.formatVersion, 1);
    assert.equal(doc.server.serverId, t.ctx.serverId);
    assert.deepEqual(doc.account, {
      id: account.user.id,
      login: account.user.login,
      createdAt: formatIso(account.user.createdAt),
      passwordChangedAt: formatIso(account.user.createdAt),
    });
    assert.deepEqual(doc.devices.map((d) => d.id).sort(), [account.device.id, second.id].sort());

    assert.deepEqual(doc.library.tracks.map((row) => row.videoId).sort(), ["vidTRACKone", "vidTRACKtwo"]);
    const stub = doc.library.tracks.find((row) => row.videoId === "vidTRACKtwo");
    assert.equal(stub?.metadataStub, true);
    assert.equal(stub.title, "vidTRACKtwo");

    assert.deepEqual(doc.library.likes, [{ videoId: "vidLIKEDone", liked: true, likedAt: formatIso(t.clock.now()) }]);
    assert.deepEqual(
      doc.library.bookmarks.map((row) => row.browseId),
      ["MPREb_marked01"],
    );

    assert.equal(doc.library.playlists.length, 1, "the soft-deleted playlist is excluded entirely");
    const playlist = doc.library.playlists[0];
    assert.equal(playlist?.id, seed.included.playlistId);
    assert.equal(playlist?.name, "Дорога");
    assert.deepEqual(
      playlist.items.map((item) => item.videoId),
      ["vidPRESENTx"],
      "a removed (present=0) item is excluded",
    );

    assert.deepEqual(
      doc.history.plays.map((row) => row.videoId),
      ["vidHISTORYx"],
    );
    assert.deepEqual(
      doc.history.playStats.map((row) => row.videoId),
      ["vidHISTORYx"],
    );
    assert.deepEqual(
      doc.history.playForgets.map((row) => row.videoId),
      ["*"],
    );

    assert.ok(doc.playback);
    assert.equal(doc.playback.queue.length, 1);
    assert.equal(doc.playback.queue[0]?.videoId, "vidPRESENTx");

    for (const excluded of seed.excludedVideoIds) {
      assert.ok(!JSON.stringify(body).includes(excluded), `${excluded} must not appear in the export`);
    }

    // No secrets anywhere in the document: no password/recovery hash, no token, no hwid (plain or hashed).
    const text = response.body;
    for (const forbidden of ["password_hash", "recovery_code_hash", "hwid", "token", "9".repeat(64)]) {
      assert.ok(!text.toLowerCase().includes(forbidden), `export leaked "${forbidden}"`);
    }
  });

  test("no library rows at all: empty arrays, playback null", async () => {
    const account = await createAccount(t.ctx);
    const response = await get(account.session.tokens.accessToken);
    assert.equal(response.statusCode, 200, response.body);
    const doc = ExportDocument.parse(json(response));
    assert.deepEqual(doc.library, { tracks: [], likes: [], bookmarks: [], playlists: [] });
    assert.deepEqual(doc.history, { plays: [], playStats: [], playForgets: [] });
    assert.equal(doc.playback, null);
    assert.deepEqual(
      doc.devices.map((d) => d.id),
      [account.device.id],
    );
  });

  test("keyset paging assembles every row, in order, across several small pages", async () => {
    const account = await createAccount(t.ctx);
    const now = t.clock.now();
    const videoIds = Array.from({ length: 5 }, (_, i) => `vidPAGE000${i}`);
    await t.db.write((q) =>
      q
        .insertInto("sync_tracks")
        .values(
          videoIds.map((videoId, i) => ({
            user_id: account.user.id,
            video_id: videoId,
            title: videoId,
            artists_text: null,
            artists: null,
            album_id: null,
            album_title: null,
            duration_ms: null,
            duration_text: null,
            thumbnail_url: null,
            video_type: null,
            seq: i + 1,
            updated_at: now,
          })),
        )
        .execute(),
    );

    const prepared = await prepareExport(t.ctx, requestAuth(account), { pageSize: 2 });
    let text = "";
    for await (const chunk of prepared.chunks) text += chunk;
    const doc = ExportDocument.parse(JSON.parse(text));
    assert.deepEqual(
      doc.library.tracks.map((row) => row.videoId),
      [...videoIds].sort(),
    );
  });

  test("the account is gone since the guard ran → session_revoked", async () => {
    const account = await createAccount(t.ctx);
    await t.db.write((q) =>
      q.updateTable("users").set({ deleted_at: t.clock.now() }).where("id", "=", account.user.id).execute(),
    );
    await assert.rejects(prepareExport(t.ctx, requestAuth(account)), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, "session_revoked");
      return true;
    });
  });

  test("3 requests per hour per user; the 4th is 429 rate_limited", async () => {
    const limited = await createTestApp({ env: { RATE_LIMIT_ENABLED: "true" } });
    try {
      const account = await createAccount(limited.ctx);
      const inject = () =>
        limited.app.inject({
          method: "GET",
          url: "/auth/me/export",
          headers: bearer(account.session.tokens.accessToken),
        });
      for (let i = 0; i < 3; i++) {
        const response = await inject();
        assert.equal(response.statusCode, 200, `request ${i + 1}: ${response.body}`);
      }
      const fourth = await inject();
      const body = assertError(fourth, 429, "rate_limited");
      assert.equal(typeof body.retryAfterSeconds, "number");
      assert.ok(fourth.headers["retry-after"]);
    } finally {
      await limited.close();
    }
  });
});
