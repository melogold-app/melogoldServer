/**
 * Request validation rules of the contract (API §1.3–§1.6, §4): UTF-16 lengths, `?` fields, time, codes, the
 * `/sync` envelope, cross-field rules. The route answers every failure here with `400 invalid_request` + `issues`.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { z } from "zod";
import {
  CheckedPassword,
  ClaimLinkRequest,
  Cursor,
  DeviceIdParams,
  DeviceInput,
  DeviceName,
  Iso,
  Login,
  MergePlanRequest,
  NewPassword,
  PlaybackPut,
  PollLinkRequest,
  PowSolution,
  RecoveryCodeInput,
  RefreshRequest,
  RenameDeviceRequest,
  ResolveLinkRequest,
  SyncRequest,
  SyncRequestEnvelope,
  TrackInput,
  UserCodeInput,
  Uuid,
  formatCodeGroups,
  normalizeCrockfordCode,
  optional,
  text,
} from "./index.ts";

const EMOJI = "😀"; // two UTF-16 units, one code point
const HWID = "3fa9c1d2e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1";
const UUID = "0c3f6a2e-5d1b-4c7a-9e8f-1a2b3c4d5e6f";
const UUID2 = "9b1e2f4a-7c3d-4e5f-8a9b-0c1d2e3f4a5b";

function issues(schema: z.ZodType, value: unknown): { path: string; code: string }[] {
  const result = schema.safeParse(value);
  assert.equal(result.success, false, `expected ${JSON.stringify(value)} to fail`);
  return result.error.issues.map((issue) => ({ path: issue.path.map(String).join("."), code: issue.code }));
}

function ok<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  assert.ok(result.success, `expected ${JSON.stringify(value)} to pass: ${JSON.stringify(result.error?.issues)}`);
  return result.data;
}

const device = { hwid: HWID, name: "Google Pixel 8", platform: "android" };

describe("strings count UTF-16 units (API §1.4)", () => {
  test("text(min, max)", () => {
    const schema = text(1, 4);
    ok(schema, "abcd");
    ok(schema, `ab${EMOJI}`); // 4 units
    assert.deepEqual(issues(schema, `abc${EMOJI}`), [{ path: "", code: "too_big" }]); // 5 units, 4 code points
    assert.deepEqual(issues(schema, ""), [{ path: "", code: "too_small" }]);
    assert.deepEqual(issues(schema, 5), [{ path: "", code: "invalid_type" }]);
  });

  test("Login: 1..64 on input", () => {
    ok(Login, "a");
    ok(Login, "x".repeat(64));
    issues(Login, "x".repeat(63) + EMOJI);
    issues(Login, "");
  });

  test("checked password: 1..128 units; a new password is not limited by the schema", () => {
    ok(CheckedPassword, "x".repeat(128));
    issues(CheckedPassword, "x".repeat(127) + EMOJI);
    issues(CheckedPassword, "");
    // The policy answers password_too_short / password_too_long itself (API §2.2), not invalid_request.
    ok(NewPassword, "");
    ok(NewPassword, "x".repeat(1000));
  });

  test("DeviceName is cleaned, then 1..64", () => {
    assert.equal(ok(DeviceName, "  My\u0000\u200e  phone\u202e\n "), "My phone");
    assert.equal(ok(DeviceName, "x".repeat(64)), "x".repeat(64));
    issues(DeviceName, "x".repeat(63) + EMOJI);
    issues(DeviceName, " \u200f\u0007 ");
    // Longer before cleaning is fine.
    assert.equal(ok(DeviceName, `${"\u200e".repeat(10)}${"x".repeat(64)}`), "x".repeat(64));
  });
});

describe("`?` fields (API §1.3)", () => {
  test("absent and null both come out as undefined; unknown keys are dropped", () => {
    const schema = optional(text(0, 3));
    assert.equal(ok(schema, null), undefined);
    assert.equal(ok(schema, undefined), undefined);
    assert.equal(ok(schema, "ab"), "ab");
    const parsed = ok(DeviceInput, { ...device, osVersion: null, extra: 1 });
    assert.equal(parsed.osVersion, undefined);
    assert.ok(!("extra" in parsed));
  });

  test("required but nullable: RenameDeviceRequest.name", () => {
    assert.equal(ok(RenameDeviceRequest, { name: null }).name, null);
    assert.equal(ok(RenameDeviceRequest, { name: " Work  laptop " }).name, "Work laptop");
    assert.deepEqual(issues(RenameDeviceRequest, {}), [{ path: "name", code: "invalid_type" }]);
  });
});

describe("formats (API §1.5, §1.6)", () => {
  test("Iso: 0–9 fraction digits truncated to ms, only Z, [2000, 2100)", () => {
    assert.equal(ok(Iso, "2026-09-23T10:00:00.123456789Z"), Date.UTC(2026, 8, 23, 10, 0, 0, 123));
    assert.equal(ok(Iso, "2026-09-23T10:00:00Z"), Date.UTC(2026, 8, 23, 10));
    assert.equal(ok(Iso, "2000-01-01T00:00:00.000Z"), Date.UTC(2000, 0, 1));
    for (const bad of [
      "2026-09-23T10:00:00+03:00",
      "2026-09-23T10:00:00.1234567890Z",
      "2026-02-30T10:00:00Z",
      "2100-01-01T00:00:00Z",
      "1999-12-31T23:59:59Z",
      "2026-09-23 10:00:00Z",
    ]) {
      assert.deepEqual(issues(Iso, bad), [{ path: "", code: "invalid_format" }], bad);
    }
  });

  test("Uuid is lowercase only; Cursor is empty or epoch.lib.hist", () => {
    ok(Uuid, UUID);
    issues(Uuid, UUID.toUpperCase());
    ok(Cursor, "");
    ok(Cursor, "a1b2c3d4.4815.4815");
    ok(Cursor, "a1b2c3d4.0.1234567890123456");
    for (const bad of ["A1B2C3D4.1.1", "a1b2c3d4.1", "a1b2c3d4.1.12345678901234567", " ", "a1b2c3d4.-1.1"]) {
      issues(Cursor, bad);
    }
  });

  test("recovery and user codes: normalized input, Crockford alphabet", () => {
    assert.equal(ok(RecoveryCodeInput, "7kq2 mx9d 4tnp b8rw 3hzf"), "7KQ2MX9D4TNPB8RW3HZF");
    assert.equal(ok(RecoveryCodeInput, "7KQ2-MX9D-4TNP-B8RW-3HZF"), "7KQ2MX9D4TNPB8RW3HZF");
    assert.equal(ok(RecoveryCodeInput, "oooo_iiii-llll 0000 1111"), "00001111111100001111");
    assert.deepEqual(issues(RecoveryCodeInput, "7KQ2-MX9D-4TNP-B8RW-3HZU"), [{ path: "", code: "invalid_format" }]);
    issues(RecoveryCodeInput, "7KQ2-MX9D-4TNP-B8RW-3HZ");
    assert.equal(ok(UserCodeInput, "k7qx m2pd"), "K7QXM2PD");
    issues(UserCodeInput, "K7QX-M2PD-1");
    assert.equal(normalizeCrockfordCode("k7qx-m2pd", 8), "K7QXM2PD");
    assert.equal(formatCodeGroups("K7QXM2PD"), "K7QX-M2PD");
    assert.equal(formatCodeGroups("7KQ2MX9D4TNPB8RW3HZF"), "7KQ2-MX9D-4TNP-B8RW-3HZF");
  });

  test("PoW solution", () => {
    ok(PowSolution, { challenge: "mgpow1.eyJuIjoiUjNKdl8xLTJ0QSJ9.kQ3v", nonce: "183422" });
    issues(PowSolution, { challenge: "mgpow1.eyJu….kQ3v", nonce: "1" });
    issues(PowSolution, { challenge: `mgpow1.${"a".repeat(250)}.b`, nonce: "1" });
    issues(PowSolution, { challenge: "mgpow1.a.b", nonce: "12345678901234567" });
  });

  test("a malformed refresh token reaches the service (401 or 204, never 400)", () => {
    ok(RefreshRequest, { refreshToken: "garbage", device: { hwid: HWID } });
    issues(RefreshRequest, { refreshToken: "mgrt1.a.b", device: {} });
  });

  test("path parameters are Uuids", () => {
    ok(DeviceIdParams, { deviceId: UUID });
    assert.deepEqual(issues(DeviceIdParams, { deviceId: "42" }), [{ path: "deviceId", code: "invalid_format" }]);
  });
});

describe("linking", () => {
  test("exactly one of linkToken and userCode", () => {
    const linkToken = "q3JdV0hZxK2mP9sT4uW7yB1cE5fH8jL0nR3vX6zA2dG";
    ok(ResolveLinkRequest, { linkToken });
    ok(ResolveLinkRequest, { userCode: "k7qx m2pd", linkToken: null });
    assert.deepEqual(issues(ResolveLinkRequest, {}), [{ path: "linkToken", code: "custom" }]);
    issues(ResolveLinkRequest, { linkToken, userCode: "K7QX-M2PD" });
    issues(ClaimLinkRequest, { linkToken, userCode: "K7QX-M2PD", device });
    ok(ClaimLinkRequest, { linkToken, device });
  });

  test("poll: waitSeconds 0..25, knownStatus pending|claimed", () => {
    const pollSecret = `mgps_${"a".repeat(43)}`;
    ok(PollLinkRequest, { pollSecret, waitSeconds: 0, knownStatus: "claimed" });
    issues(PollLinkRequest, { pollSecret, waitSeconds: 26 });
    issues(PollLinkRequest, { pollSecret, knownStatus: "completed" });
    issues(PollLinkRequest, { pollSecret: `mgps_${"a".repeat(42)}` });
  });
});

describe("POST /sync envelope (DESIGN §3.9)", () => {
  const op = (overrides: Record<string, unknown> = {}) => ({
    opId: UUID,
    kind: "like.set",
    at: "2026-09-23T10:00:00Z",
    ...overrides,
  });

  test("only opId, kind, at, base are checked; other fields pass through untouched", () => {
    const parsed = ok(SyncRequestEnvelope, {
      cursor: "",
      ops: [op({ videoId: 42, liked: "yes", tracks: "garbage", kind: "some.future.kind" })],
    });
    assert.deepEqual(parsed.ops?.[0], {
      opId: UUID,
      kind: "some.future.kind",
      at: Date.UTC(2026, 8, 23, 10),
      videoId: 42,
      liked: "yes",
      tracks: "garbage",
    });
    // The typed SyncRequest (OpenAPI only) would reject the same op: it must never validate the route.
    issues(SyncRequest, { cursor: "", ops: [op({ videoId: 42 })] });
  });

  test("common fields", () => {
    assert.deepEqual(issues(SyncRequestEnvelope, { cursor: "", ops: [op({ kind: "" })] }), [
      { path: "ops.0.kind", code: "too_small" },
    ]);
    issues(SyncRequestEnvelope, { cursor: "", ops: [op({ kind: "k".repeat(65) })] });
    ok(SyncRequestEnvelope, { cursor: "", ops: [op({ base: "b".repeat(64) })] });
    issues(SyncRequestEnvelope, { cursor: "", ops: [op({ base: "b".repeat(65) })] });
    issues(SyncRequestEnvelope, { cursor: "", ops: [op({ at: "yesterday" })] });
    issues(SyncRequestEnvelope, { cursor: "", ops: [op({ opId: "not-a-uuid" })] });
    issues(SyncRequestEnvelope, { ops: [] });
  });

  test("duplicate opIds, too many ops", () => {
    assert.deepEqual(issues(SyncRequestEnvelope, { cursor: "", ops: [op(), op({ kind: "x" })] }), [
      { path: "ops.1.opId", code: "custom" },
    ]);
    const many = Array.from({ length: 501 }, (_, index) =>
      op({ opId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` }),
    );
    issues(SyncRequestEnvelope, { cursor: "", ops: many });
    ok(SyncRequestEnvelope, { cursor: "", ops: many.slice(0, 500) });
  });

  test("limit, streams, include", () => {
    ok(SyncRequestEnvelope, { cursor: "", limit: 2000, streams: ["history"] });
    issues(SyncRequestEnvelope, { cursor: "", limit: 0 });
    issues(SyncRequestEnvelope, { cursor: "", limit: 2001 });
    issues(SyncRequestEnvelope, { cursor: "", streams: [] });
    issues(SyncRequestEnvelope, { cursor: "", streams: ["library", "library"] });
    issues(SyncRequestEnvelope, { cursor: "", streams: ["everything"] });
    const videoIds = Array.from({ length: 600 }, () => "dQw4w9WgXcQ");
    ok(SyncRequestEnvelope, {
      cursor: "",
      include: { likes: videoIds.slice(0, 500), playStats: videoIds.slice(0, 500) },
    });
    assert.deepEqual(issues(SyncRequestEnvelope, { cursor: "", include: { likes: videoIds, playStats: videoIds } }), [
      { path: "include", code: "too_big" },
    ]);
    issues(SyncRequestEnvelope, { cursor: "", include: { likes: ["short"] } });
    issues(SyncRequestEnvelope, { cursor: "", include: { bookmarks: [{ type: "song", browseId: "x" }] } });
  });

  test("merge plan: unique localKey, name 1..200, at most 5000", () => {
    ok(MergePlanRequest, { playlists: [] });
    ok(MergePlanRequest, { playlists: [{ localKey: "17", name: "rock", syncId: null, browseId: "VLPL whatever" }] });
    assert.deepEqual(
      issues(MergePlanRequest, {
        playlists: [
          { localKey: "17", name: "a" },
          { localKey: "17", name: "b" },
        ],
      }),
      [{ path: "playlists.1.localKey", code: "custom" }],
    );
    issues(MergePlanRequest, { playlists: [{ localKey: "1", name: "x".repeat(201) }] });
    issues(MergePlanRequest, { playlists: [{ localKey: "1", name: "" }] });
  });
});

describe("PUT /playback/state", () => {
  const put = (overrides: Record<string, unknown> = {}) => ({
    sessionId: UUID,
    queueVersion: 3,
    at: "2026-09-23T10:00:00.000Z",
    index: 0,
    positionMs: 83_000,
    playing: true,
    ...overrides,
  });

  test("index must be inside the queue it comes with", () => {
    ok(PlaybackPut, put({ queue: [{ videoId: "dQw4w9WgXcQ" }] }));
    assert.deepEqual(issues(PlaybackPut, put({ index: 1, queue: [{ videoId: "dQw4w9WgXcQ" }] })), [
      { path: "index", code: "too_big" },
    ]);
    // Without a queue, the service checks index against the stored one.
    ok(PlaybackPut, put({ index: 199 }));
    issues(PlaybackPut, put({ index: 200 }));
    issues(PlaybackPut, put({ queue: [] }));
  });

  test("queue items: a bad videoId is 400, bad metadata passes (cleaned by the service)", () => {
    assert.deepEqual(issues(PlaybackPut, put({ queue: [{ videoId: "local:123" }] })), [
      { path: "queue.0.videoId", code: "invalid_format" },
    ]);
    const parsed = ok(
      PlaybackPut,
      put({ queue: [{ videoId: "dQw4w9WgXcQ", title: 42, artists: "x", thumbnailUrl: "ftp://x" }] }),
    );
    assert.deepEqual(parsed.queue?.[0], { videoId: "dQw4w9WgXcQ", title: 42, artists: "x", thumbnailUrl: "ftp://x" });
    ok(TrackInput, { videoId: "dQw4w9WgXcQ", artistsText: "a".repeat(10_000) });
  });

  test("Int32 above 2^31 − 1 is a 400, not a 500 (M12)", () => {
    issues(PlaybackPut, put({ queueVersion: 2 ** 31 }));
    ok(PlaybackPut, put({ queueVersion: 2 ** 31 - 1 }));
    issues(PlaybackPut, put({ positionMs: 2 ** 53 }));
    issues(PlaybackPut, put({ positionMs: 1.5 }));
    ok(PlaybackPut, put({ handoffFrom: { deviceId: UUID2, sessionId: UUID } }));
  });
});
