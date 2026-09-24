import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { OpResult, SYNC_OP_KINDS, SYNC_OP_KIND_SPECS, SyncOpEnvelope } from "../../../contract/sync.ts";
import { OP_HANDLERS, buildOpHandlers, implementedOpKinds, opHandlerFor, stubOpHandler } from "./index.ts";
import {
  applied,
  bookmarkKey,
  createRequestCounters,
  deferred,
  itemKey,
  localeFromAcceptLanguage,
  newTouchedKeys,
  opRateLimited,
  parsed,
  redirected,
  rejected,
  superseded,
  toOpResult,
} from "./types.ts";
import type { OpCtx, OpHandler, ParsedOp, WireOp } from "./types.ts";

const OP_ID = "3f0c1d2e-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
const PLAYLIST = "c9d1e2f3-a4b5-5c6d-8e7f-9a0b1c2d3e4f";

function wire(kind: string, fields: Record<string, unknown> = {}): WireOp {
  return SyncOpEnvelope.parse({ opId: OP_ID, kind, at: "2026-09-23T10:00:00.000Z", ...fields });
}

describe("op registry", () => {
  test("one real handler per kind of API §4.8 (T2.1 library, T2.2 playlists, T2.3 history)", () => {
    assert.deepEqual(Object.keys(OP_HANDLERS), [...SYNC_OP_KINDS]);
    for (const kind of SYNC_OP_KINDS) {
      const handler = OP_HANDLERS[kind];
      assert.equal(handler.kind, kind);
      assert.equal(handler.implemented, true, kind);
      assert.equal(handler.journaled, SYNC_OP_KIND_SPECS[kind].journaled, kind);
    }
    assert.deepEqual(implementedOpKinds(), [...SYNC_OP_KINDS]);
  });

  test("a stub answers deferred unknown_kind at parse and apply, and touches nothing", async () => {
    for (const kind of SYNC_OP_KINDS) {
      const handler = stubOpHandler(kind);
      assert.equal(handler.implemented, false);
      assert.deepEqual(handler.parse(wire(kind)), {
        ok: false,
        outcome: { status: "deferred", code: "unknown_kind" },
      });
      assert.deepEqual(await handler.apply({} as OpCtx, {} as ParsedOp, { effAt: 0, base: null }), {
        status: "deferred",
        code: "unknown_kind",
      });
      const touched = newTouchedKeys();
      handler.touch(wire(kind), touched);
      assert.deepEqual(
        Object.values(touched).map((keys) => keys.size),
        [0, 0, 0, 0, 0, 0],
      );
    }
  });

  test("unknown kinds have no handler (prototype keys included)", () => {
    assert.equal(opHandlerFor(OP_HANDLERS, "like.set"), OP_HANDLERS["like.set"]);
    for (const kind of ["like.get", "constructor", "__proto__", "toString", ""]) {
      assert.equal(opHandlerFor(OP_HANDLERS, kind), null, kind);
    }
  });

  test("real handlers replace stubs; features.sync.kinds lists them", () => {
    type LikeOp = ParsedOp & Readonly<{ videoId: string; liked: boolean }>;
    const likeSet: OpHandler<LikeOp> = {
      kind: "like.set",
      implemented: true,
      journaled: true,
      parse: (raw) =>
        parsed({
          opId: raw.opId,
          kind: "like.set",
          at: raw.at,
          tracks: raw.tracks,
          trackVideoIds: [String(raw.videoId)],
          videoId: String(raw.videoId),
          liked: raw.liked === true,
        }),
      apply: (_oc, op) => Promise.resolve(op.liked ? applied() : superseded()),
      touch: (raw, touched) => {
        if (typeof raw.videoId === "string") touched.likes.add(raw.videoId);
      },
    };
    const handlers = buildOpHandlers({ "like.set": likeSet });
    assert.deepEqual(implementedOpKinds(handlers), ["like.set"]);
    assert.equal(handlers["bookmark.set"].implemented, false);
    assert.throws(() => buildOpHandlers({ "bookmark.set": likeSet }), /registered as/);
    assert.equal(stubOpHandler("play.add").journaled, false);
  });
});

describe("outcomes → OpResult (API §4.8, §2.3)", () => {
  const result = (outcome: Parameters<typeof toOpResult>[1], seq: number | null, replayed = false) => {
    const value = toOpResult(OP_ID, outcome, seq, replayed);
    assert.ok(OpResult.safeParse(value).success);
    return value;
  };
  const base = { opId: OP_ID, code: null, seq: null, playlistId: null, retryAfterSeconds: null, replayed: false };

  test("applied, superseded, redirected carry the seq; deferred and rejected never do", () => {
    assert.deepEqual(result(applied(), 4802), { ...base, status: "applied", seq: 4802 });
    assert.deepEqual(result(superseded(), 4803, true), { ...base, status: "superseded", seq: 4803, replayed: true });
    assert.deepEqual(result(redirected(PLAYLIST), 4805), {
      ...base,
      status: "redirected",
      seq: 4805,
      playlistId: PLAYLIST,
    });
    assert.deepEqual(result(rejected("playlist_deleted"), 7), {
      ...base,
      status: "rejected",
      code: "playlist_deleted",
    });
    assert.deepEqual(result(deferred("quota_exceeded"), 7), { ...base, status: "deferred", code: "quota_exceeded" });
    assert.deepEqual(result(opRateLimited(1200), null), {
      ...base,
      status: "deferred",
      code: "op_rate_limited",
      retryAfterSeconds: 1200,
    });
  });

  test("outcome helpers keep their extras", () => {
    assert.deepEqual(applied({ seq: 5, preImage: { name: "x" } }), {
      status: "applied",
      seq: 5,
      preImage: { name: "x" },
    });
    assert.deepEqual(redirected(PLAYLIST, [1]), { status: "redirected", playlistId: PLAYLIST, preImage: [1] });
  });
});

describe("request state helpers", () => {
  test("counters load once and follow adds", async () => {
    const counters = createRequestCounters();
    let loads = 0;
    const load = () => {
      loads += 1;
      return Promise.resolve(10);
    };
    counters.add("likes", 5); // not loaded yet: ignored
    assert.equal(await counters.get("likes", load), 10);
    counters.add("likes", 2);
    assert.equal(await counters.get("likes", load), 12);
    assert.equal(loads, 1);
    const [a, b] = await Promise.all([counters.get("items", load), counters.get("items", load)]);
    assert.equal(a, 10);
    assert.equal(b, 10);
    await assert.rejects(
      counters.get("bad", () => Promise.resolve(-1)),
      RangeError,
    );
    await assert.rejects(
      counters.get("bad", () => Promise.resolve(1.5)),
      RangeError,
    );
  });

  test("touched keys", () => {
    const touched = newTouchedKeys();
    touched.bookmarks.add(bookmarkKey("album", "MPREb_x"));
    touched.items.add(itemKey(PLAYLIST, "dQw4w9WgXcQ"));
    assert.deepEqual([...touched.bookmarks], ["album:MPREb_x"]);
    assert.deepEqual([...touched.items], [`${PLAYLIST}:dQw4w9WgXcQ`]);
    assert.notEqual(newTouchedKeys().likes, touched.likes);
  });

  test("Accept-Language: ru* → ru, anything else → en", () => {
    for (const header of ["ru", "ru-RU", "RU-ru,en;q=0.8", " ru ;q=1", "ru-RU,ru;q=0.9,en-US;q=0.8"]) {
      assert.equal(localeFromAcceptLanguage(header), "ru", header);
    }
    for (const header of [undefined, "", "en-US,ru;q=0.9", "rus", "*", "uk-UA"]) {
      assert.equal(localeFromAcceptLanguage(header), "en", String(header));
    }
  });
});
