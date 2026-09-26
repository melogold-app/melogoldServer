/**
 * `track.override.set` and `lyrics.pin.set` on the real `POST /sync` route (API §4.8, DESIGN §3.7, server tasks
 * 0001/0002): set, replace, remove (a tombstone), no-ops that spend no `seq`, the later `at` winning, `include`, the
 * pull of another device, `like.set` with the original `tracks[]` leaving an override alone, and the quota.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { LightMyRequestResponse } from "fastify";
import { SYNC_LIMITS } from "../../contract/limits.ts";
import { insertInChunks } from "../../db/batch.ts";
import { toDbBool } from "../../db/codecs.ts";
import { newId } from "../../lib/ids.ts";
import { bearer, createAccount, createDevice, createSession } from "../../test/factories.ts";
import type { TestAccount } from "../../test/factories.ts";
import { createTestApp, json } from "../../test/test-app.ts";
import type { TestApp } from "../../test/test-app.ts";
import { implementedOpKinds } from "./ops/index.ts";
import { LYRICS_PINS_QUOTA, TRACK_OVERRIDES_QUOTA } from "./quotas.ts";

let t: TestApp;

before(async () => {
  t = await createTestApp();
});

after(async () => {
  await t.close();
});

type Account = Readonly<{ account: TestAccount; phone: string; laptop: string }>;

async function newAccount(): Promise<Account> {
  const account = await createAccount(t.ctx);
  const device = await createDevice(t.db, account.user.id);
  const session = await createSession(t.ctx, { userId: account.user.id, deviceId: device.id });
  return { account, phone: account.session.tokens.accessToken, laptop: session.tokens.accessToken };
}

function postSync(token: string, body: Record<string, unknown>): Promise<LightMyRequestResponse> {
  return t.app.inject({
    method: "POST",
    url: "/sync",
    headers: { ...bearer(token), "x-sync-protocol": "1", "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
}

const iso = (ms: number) => new Date(ms).toISOString();

async function sendOp(
  token: string,
  op: Record<string, unknown>,
  cursor = "",
): Promise<Readonly<{ result: Record<string, unknown>; body: Record<string, unknown> }>> {
  const response = await postSync(token, { cursor, ops: [{ opId: newId(), at: iso(t.clock.now()), ...op }] });
  assert.equal(response.statusCode, 200, response.body);
  const body = json(response);
  const result = (body.results as Record<string, unknown>[])[0];
  assert.ok(result);
  return { result, body };
}

async function headSeq(userId: string): Promise<number> {
  return t.db.read((q) =>
    q
      .selectFrom("sync_heads")
      .select("seq")
      .where("user_id", "=", userId)
      .executeTakeFirstOrThrow()
      .then((row) => row.seq),
  );
}

const VIDEO = "a1B2c3D4e5F";

describe("features.sync.kinds", () => {
  test("lists track.override.set and lyrics.pin.set", async () => {
    assert.ok(implementedOpKinds().includes("track.override.set"));
    assert.ok(implementedOpKinds().includes("lyrics.pin.set"));
    const info = json(await t.app.inject({ method: "GET", url: "/server/info" }));
    const kinds = (info.features as { sync: { kinds: string[] } }).sync.kinds;
    assert.ok(kinds.includes("track.override.set") && kinds.includes("lyrics.pin.set"), kinds.join(","));
  });

  test("the quotas match API §11", () => {
    assert.equal(TRACK_OVERRIDES_QUOTA.limit, SYNC_LIMITS.maxTrackOverrides);
    assert.equal(LYRICS_PINS_QUOTA.limit, 150_000);
    assert.equal(SYNC_LIMITS.maxLyricsPins, 150_000);
  });
});

describe("track.override.set", () => {
  test("set: trimmed fields, empty ones null; the row comes back in the response", async () => {
    const { phone } = await newAccount();
    const { result, body } = await sendOp(phone, {
      kind: "track.override.set",
      videoId: VIDEO,
      title: "  Song  ",
      artistsText: "",
      albumTitle: "Lost Album",
    });
    assert.equal(result.status, "applied");
    assert.equal(result.code, null);
    assert.deepEqual(body.overrides, [
      {
        videoId: VIDEO,
        title: "Song",
        artistsText: null,
        albumTitle: "Lost Album",
        updatedAt: iso(t.clock.now()),
        deleted: false,
      },
    ]);
  });

  test("replace whole, no-op spends no seq, remove makes a tombstone; another device pulls it", async () => {
    const { account, phone, laptop } = await newAccount();
    await sendOp(phone, { kind: "track.override.set", videoId: VIDEO, title: "A", artistsText: "B" });

    t.clock.advance(1000);
    const replaced = await sendOp(phone, { kind: "track.override.set", videoId: VIDEO, albumTitle: "C" });
    assert.equal(replaced.result.status, "applied");
    assert.deepEqual(
      (replaced.body.overrides as Record<string, unknown>[]).map(({ title, artistsText, albumTitle, deleted }) => ({
        title,
        artistsText,
        albumTitle,
        deleted,
      })),
      [{ title: null, artistsText: null, albumTitle: "C", deleted: false }],
      "absent fields have no override: the op replaces the whole row",
    );

    const seq = await headSeq(account.user.id);
    t.clock.advance(1000);
    const same = await sendOp(phone, { kind: "track.override.set", videoId: VIDEO, albumTitle: " C " });
    assert.equal(same.result.status, "applied");
    assert.equal(same.result.seq, null, "a no-op is not journaled");
    assert.equal(await headSeq(account.user.id), seq, "a no-op spends no seq");

    t.clock.advance(1000);
    const removed = await sendOp(phone, { kind: "track.override.set", videoId: VIDEO, title: "   " });
    assert.equal(removed.result.status, "applied");
    const tombstone = (removed.body.overrides as Record<string, unknown>[])[0];
    assert.deepEqual(tombstone, {
      videoId: VIDEO,
      title: null,
      artistsText: null,
      albumTitle: null,
      updatedAt: iso(t.clock.now()),
      deleted: true,
    });

    const pulled = json(await postSync(laptop, { cursor: "" }));
    assert.deepEqual(pulled.overrides, [tombstone]);
  });

  test("removing an override that does not exist writes nothing", async () => {
    const { account, phone } = await newAccount();
    const seq = await headSeq(account.user.id);
    const { result, body } = await sendOp(phone, { kind: "track.override.set", videoId: VIDEO });
    assert.equal(result.status, "applied");
    assert.equal(await headSeq(account.user.id), seq);
    assert.deepEqual(body.overrides, []);
  });

  test("concurrent edits: the later at wins, the earlier is superseded", async () => {
    const { phone, laptop } = await newAccount();
    const start = t.clock.now();
    t.clock.advance(10_000);
    const late = await sendOp(laptop, {
      kind: "track.override.set",
      videoId: VIDEO,
      title: "Late",
      at: iso(start + 5000),
      base: "",
    });
    assert.equal(late.result.status, "applied");
    const early = await sendOp(phone, {
      kind: "track.override.set",
      videoId: VIDEO,
      title: "Early",
      at: iso(start + 1000),
      base: "",
    });
    assert.equal(early.result.status, "superseded");
    assert.equal((early.body.overrides as Record<string, unknown>[])[0]?.title, "Late");
  });

  test("like.set with the original YouTube tracks[] leaves the override alone", async () => {
    const { phone, laptop } = await newAccount();
    await sendOp(phone, { kind: "track.override.set", videoId: VIDEO, title: "Own", albumTitle: "Own Album" });
    t.clock.advance(1000);
    await sendOp(laptop, {
      kind: "like.set",
      videoId: VIDEO,
      liked: true,
      tracks: [{ videoId: VIDEO, title: "Artist — Song (fan upload)", artistsText: "Some Channel" }],
    });
    const pulled = json(await postSync(phone, { cursor: "" }));
    const override = (pulled.overrides as Record<string, unknown>[])[0];
    assert.equal(override?.title, "Own");
    assert.equal(override.albumTitle, "Own Album");
    const track = (pulled.tracks as Record<string, unknown>[]).find((row) => row.videoId === VIDEO);
    assert.equal(track?.title, "Artist — Song (fan upload)", "sync_tracks keeps the YouTube metadata");
  });

  test("a long title is cut to 500 UTF-16 units without splitting a surrogate pair", async () => {
    const { phone } = await newAccount();
    const { body } = await sendOp(phone, {
      kind: "track.override.set",
      videoId: VIDEO,
      title: `${"a".repeat(499)}😀tail`,
      artistsText: 42,
    });
    const row = (body.overrides as Record<string, unknown>[])[0];
    assert.equal(row?.title, "a".repeat(499));
    assert.equal(row.artistsText, null, "a mistyped field has no override");
  });

  test("videoId: invalid → rejected invalid_video_id, missing → deferred invalid_payload", async () => {
    const { phone } = await newAccount();
    const invalid = await sendOp(phone, { kind: "track.override.set", videoId: "short", title: "x" });
    assert.deepEqual([invalid.result.status, invalid.result.code], ["rejected", "invalid_video_id"]);
    const missing = await sendOp(phone, { kind: "track.override.set", title: "x" });
    assert.deepEqual([missing.result.status, missing.result.code], ["deferred", "invalid_payload"]);
  });

  test("include.overrides returns the current rows", async () => {
    const { phone, laptop } = await newAccount();
    const { body } = await sendOp(phone, { kind: "track.override.set", videoId: VIDEO, title: "Own" });
    const response = json(
      await postSync(laptop, { cursor: body.cursor, include: { overrides: [VIDEO, "abcdefghijk"] } }),
    );
    assert.deepEqual(
      (response.overrides as Record<string, unknown>[]).map((row) => row.title),
      ["Own"],
    );
  });

  test("a new override at the 150 000 quota is deferred quota_exceeded; an existing one still updates", async () => {
    const { account, phone } = await newAccount();
    const now = t.clock.now();
    const rows = Array.from({ length: SYNC_LIMITS.maxTrackOverrides }, (_, i) => ({
      user_id: account.user.id,
      video_id: `q${String(i).padStart(10, "0")}`,
      title: "t",
      artists_text: null,
      album_title: null,
      updated_at: now,
      seq: i + 1,
      deleted: toDbBool(false),
      clk_at: now,
      clk_dev: null,
    }));
    await insertInChunks(rows, (chunk) =>
      t.db.write((q) => q.insertInto("sync_track_overrides").values(chunk).execute()),
    );
    await t.db.write((q) =>
      q.updateTable("sync_heads").set({ seq: rows.length }).where("user_id", "=", account.user.id).execute(),
    );
    t.clock.advance(1000);
    const over = await sendOp(phone, { kind: "track.override.set", videoId: VIDEO, title: "x" });
    assert.deepEqual([over.result.status, over.result.code], ["deferred", "quota_exceeded"]);
    assert.equal(await headSeq(account.user.id), rows.length);
    const existing = await sendOp(phone, { kind: "track.override.set", videoId: "q0000000000", title: "y" });
    assert.equal(existing.result.status, "applied");
  });
});

describe("lyrics.pin.set", () => {
  test("set, replace, remove by an empty ref or an unknown source", async () => {
    const { phone, laptop } = await newAccount();
    const set = await sendOp(phone, {
      kind: "lyrics.pin.set",
      videoId: VIDEO,
      source: "lrclib",
      ref: " 123456 ",
      startTimeMs: 1500,
    });
    assert.equal(set.result.status, "applied");
    assert.deepEqual(set.body.lyricsPins, [
      {
        videoId: VIDEO,
        source: "lrclib",
        ref: "123456",
        startTimeMs: 1500,
        updatedAt: iso(t.clock.now()),
        deleted: false,
      },
    ]);

    t.clock.advance(1000);
    const replaced = await sendOp(phone, {
      kind: "lyrics.pin.set",
      videoId: VIDEO,
      source: "youtube_music",
      ref: "MPLYt_abc",
      startTimeMs: 86_400_001,
    });
    const row = (replaced.body.lyricsPins as Record<string, unknown>[])[0];
    assert.deepEqual([row?.source, row?.ref, row?.startTimeMs], ["youtube_music", "MPLYt_abc", null]);

    t.clock.advance(1000);
    const unknown = await sendOp(phone, { kind: "lyrics.pin.set", videoId: VIDEO, source: "genius", ref: "1" });
    assert.equal(unknown.result.status, "applied");
    const tombstone = (unknown.body.lyricsPins as Record<string, unknown>[])[0];
    assert.deepEqual(tombstone, {
      videoId: VIDEO,
      source: null,
      ref: null,
      startTimeMs: null,
      updatedAt: iso(t.clock.now()),
      deleted: true,
    });

    const pulled = json(await postSync(laptop, { cursor: "", include: { lyricsPins: [VIDEO] } }));
    assert.deepEqual(pulled.lyricsPins, [tombstone]);

    t.clock.advance(1000);
    const again = await sendOp(phone, { kind: "lyrics.pin.set", videoId: VIDEO, source: "kugou", ref: "" });
    assert.equal(again.result.status, "applied");
    assert.equal(again.result.seq, null, "removing a removed pin is a no-op");
  });

  test("the same pin again is a no-op; the later at wins", async () => {
    const { account, phone, laptop } = await newAccount();
    const pin = { kind: "lyrics.pin.set", videoId: VIDEO, source: "kugou", ref: "42:abc" };
    await sendOp(phone, pin);
    const seq = await headSeq(account.user.id);
    const same = await sendOp(laptop, pin);
    assert.equal(same.result.status, "applied");
    assert.equal(await headSeq(account.user.id), seq);

    const start = t.clock.now();
    t.clock.advance(10_000);
    await sendOp(laptop, { ...pin, ref: "43:def", at: iso(start + 5000), base: "" });
    const early = await sendOp(phone, { ...pin, ref: "44:ghi", at: iso(start + 1000), base: "" });
    assert.equal(early.result.status, "superseded");
    assert.equal((early.body.lyricsPins as Record<string, unknown>[])[0]?.ref, "43:def");
  });

  test("a ref longer than 200 is cut", async () => {
    const { phone } = await newAccount();
    const { body } = await sendOp(phone, {
      kind: "lyrics.pin.set",
      videoId: VIDEO,
      source: "lrclib",
      ref: "9".repeat(250),
    });
    assert.equal((body.lyricsPins as Record<string, unknown>[])[0]?.ref, "9".repeat(200));
  });
});
