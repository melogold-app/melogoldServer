/**
 * `GET`/`PUT`/`DELETE /playback/state` over HTTP (API §4.9, DESIGN §3.12.3, PLAN T2.4 acceptance), on both dialects
 * (`npm test`, `npm run test:pg`). The pure rule engine has its own tests (`playback.rules.test.ts` plus the shared
 * `spec/playback-rules.vectors.json`); this file checks the wiring: auth, `X-Sync-Protocol`, body limits, CAS over
 * real transactions, and `playback.updated` reaching every device but the author.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { LiveEvent } from "../../contract/live.ts";
import type { PlaybackPutResult, PlaybackStateResponse } from "../../contract/playback.ts";
import type { AppContext } from "../../context.ts";
import { formatIso } from "../../lib/time.ts";
import { bearer, createAccount, createDevice, createSession } from "../../test/factories.ts";
import { createTestApp, json } from "../../test/test-app.ts";
import type { TestApp } from "../../test/test-app.ts";

const XSP = { "x-sync-protocol": "1" };
/** `playback.updated` coalesces per user for `PLAYBACK_UPDATED_COALESCE_MS` of *real* time (the hub's own timers,
 * independent of the test's manual clock): tests that check two of a user's events in a row wait past that window
 * so the second one is not silently merged into a still-pending trailing event. */
const COALESCE_WINDOW_MS = 1100;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const VALID_TRACK = { videoId: "dQw4w9WgXcQ", title: "Never Gonna Give You Up", artistsText: "Rick Astley" };

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

/** A second device (and session) of the same account, for multi-device scenarios. */
async function secondDevice(t: TestApp, userId: string, name = "Google Pixel 8") {
  const device = await createDevice(t.db, userId, { now: t.clock.now(), name });
  const session = await createSession(t.ctx, { userId, deviceId: device.id, now: t.clock.now() });
  return { device, session };
}

function putBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: "e2a1b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5c",
    queueVersion: 1,
    at: formatIso(Date.UTC(2026, 8, 23, 10, 0, 0)),
    index: 0,
    positionMs: 0,
    durationMs: 213_000,
    playing: true,
    queue: [VALID_TRACK],
    ...overrides,
  };
}

let t: TestApp;

before(async () => {
  t = await createTestApp();
});
after(() => t.close());

describe("GET /playback/state", () => {
  test("no state yet: state is null", async () => {
    const account = await createAccount(t.ctx);
    const response = await t.app.inject({
      method: "GET",
      url: "/playback/state",
      headers: { ...bearer(account.session.tokens.accessToken), ...XSP },
    });
    assert.equal(response.statusCode, 200);
    const body = json(response) as unknown as PlaybackStateResponse;
    assert.equal(body.state, null);
    assert.equal(body.serverTime, formatIso(t.clock.now()));
  });
});

describe("PUT /playback/state", () => {
  test("creates the first row, publishes playback.updated to other devices only, GET reflects it", async () => {
    const account = await createAccount(t.ctx);
    const other = await secondDevice(t, account.user.id);
    const watcher = watch(t.ctx, account.user.id, other.device.id);
    const authorWatcher = watch(t.ctx, account.user.id, account.device.id);

    const at = formatIso(t.clock.now());
    const response = await t.app.inject({
      method: "PUT",
      url: "/playback/state",
      headers: { ...bearer(account.session.tokens.accessToken), ...XSP },
      payload: putBody({ at }),
    });
    assert.equal(response.statusCode, 200);
    const result = json(response) as unknown as PlaybackPutResult;
    assert.equal(result.applied, true);
    assert.equal(result.reason, null);
    assert.equal(result.state, null);
    assert.ok(typeof result.rev === "number" && result.rev > 0);

    // playback.updated reached the other device, and only it (DESIGN §3.12.4).
    assert.equal(authorWatcher.events.length, 0, "the author never receives its own playback.updated");
    assert.equal(watcher.events.length, 1);
    const event = watcher.events[0];
    assert.ok(event);
    assert.equal(event.type, "playback.updated");
    const payload = event.payload as { rev: number; cleared: boolean; state: Record<string, unknown> };
    assert.equal(payload.cleared, false);
    assert.equal(payload.rev, result.rev);
    assert.equal(payload.state.deviceId, account.device.id);
    assert.equal(payload.state.playing, true);
    assert.equal(payload.state.queueLength, 1);
    assert.deepEqual(payload.state.track, {
      videoId: "dQw4w9WgXcQ",
      title: "Never Gonna Give You Up",
      artistsText: "Rick Astley",
      artists: [],
      albumId: null,
      albumTitle: null,
      durationMs: null,
      durationText: null,
      thumbnailUrl: null,
      explicit: false,
      videoType: null,
      metadataStub: false,
    });

    const getResponse = await t.app.inject({
      method: "GET",
      url: "/playback/state",
      headers: { ...bearer(account.session.tokens.accessToken), ...XSP },
    });
    const getBody = json(getResponse) as unknown as PlaybackStateResponse;
    assert.ok(getBody.state);
    assert.equal(getBody.state.rev, result.rev);
    assert.equal(getBody.state.deviceId, account.device.id);
    assert.equal(getBody.state.deviceName, account.device.name);
    assert.equal(getBody.state.sessionId, "e2a1b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5c");
    assert.equal(getBody.state.queueVersion, 1);
    assert.equal(getBody.state.index, 0);
    assert.equal(getBody.state.durationMs, 213_000);
    assert.equal(getBody.state.at, at);
    assert.equal(getBody.state.queue.length, 1);
    assert.equal(getBody.state.handoffFrom, null);

    watcher.unregister();
    authorWatcher.unregister();
  });

  test("without a stored row, omitting queue is 409 playback_queue_required", async () => {
    const account = await createAccount(t.ctx);
    const response = await t.app.inject({
      method: "PUT",
      url: "/playback/state",
      headers: { ...bearer(account.session.tokens.accessToken), ...XSP },
      payload: putBody({ queue: undefined }),
    });
    assert.equal(response.statusCode, 409);
    assert.equal(json(response).code, "playback_queue_required");
  });

  test("the same device and session can omit queue: it reuses the stored one", async () => {
    const account = await createAccount(t.ctx);
    const created = await t.app.inject({
      method: "PUT",
      url: "/playback/state",
      headers: { ...bearer(account.session.tokens.accessToken), ...XSP },
      payload: putBody(),
    });
    assert.equal(created.statusCode, 200);

    t.clock.advance(5000);
    const reused = await t.app.inject({
      method: "PUT",
      url: "/playback/state",
      headers: { ...bearer(account.session.tokens.accessToken), ...XSP },
      payload: putBody({ queue: undefined, positionMs: 5000, at: formatIso(t.clock.now()) }),
    });
    assert.equal(reused.statusCode, 200);
    const result = json(reused) as unknown as PlaybackPutResult;
    assert.equal(result.applied, true);
    assert.ok(result.rev !== null && result.rev > (json(created) as unknown as PlaybackPutResult).rev!);

    const getResponse = await t.app.inject({
      method: "GET",
      url: "/playback/state",
      headers: { ...bearer(account.session.tokens.accessToken), ...XSP },
    });
    const state = (json(getResponse) as unknown as PlaybackStateResponse).state;
    assert.ok(state);
    assert.equal(state.positionMs, 5000);
    assert.equal(state.queue.length, 1, "the queue was reused, not dropped");
  });

  test("a different device without queue is 409, even though a row exists", async () => {
    const account = await createAccount(t.ctx);
    await t.app.inject({
      method: "PUT",
      url: "/playback/state",
      headers: { ...bearer(account.session.tokens.accessToken), ...XSP },
      payload: putBody(),
    });
    const other = await secondDevice(t, account.user.id);
    const response = await t.app.inject({
      method: "PUT",
      url: "/playback/state",
      headers: { ...bearer(other.session.tokens.accessToken), ...XSP },
      payload: putBody({ sessionId: "41c0d1e2-f3a4-4b5c-8d6e-7f8a9b0c1d2e", queue: undefined }),
    });
    assert.equal(response.statusCode, 409);
    assert.equal(json(response).code, "playback_queue_required");
  });

  test("a stale write from another device is rejected as newer_state, with the current state returned", async () => {
    const account = await createAccount(t.ctx);
    t.clock.advance(10_000);
    const created = await t.app.inject({
      method: "PUT",
      url: "/playback/state",
      headers: { ...bearer(account.session.tokens.accessToken), ...XSP },
      payload: putBody({ at: formatIso(t.clock.now()) }),
    });
    const createdRev = (json(created) as unknown as PlaybackPutResult).rev;

    const other = await secondDevice(t, account.user.id);
    const stale = await t.app.inject({
      method: "PUT",
      url: "/playback/state",
      headers: { ...bearer(other.session.tokens.accessToken), ...XSP },
      payload: putBody({
        sessionId: "41c0d1e2-f3a4-4b5c-8d6e-7f8a9b0c1d2e",
        at: formatIso(t.clock.now() - 5000), // earlier than the stored state_at
      }),
    });
    assert.equal(stale.statusCode, 200);
    const result = json(stale) as unknown as PlaybackPutResult;
    assert.equal(result.applied, false);
    assert.equal(result.reason, "newer_state");
    assert.equal(result.rev, null);
    assert.ok(result.state);
    assert.equal(result.state.rev, createdRev);
    assert.equal(result.state.deviceId, account.device.id);
    assert.equal(result.state.queue.length, 1, "the full current state, with its queue, is returned");
  });

  test("handoff: 'listen here' on device B, then A trying its old session is handed_off", async () => {
    const account = await createAccount(t.ctx);
    const b = await secondDevice(t, account.user.id, "MacBook Air");
    const sessionA = "e2a1b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5c";
    const sessionB = "41c0d1e2-f3a4-4b5c-8d6e-7f8a9b0c1d2e";

    const initial = await t.app.inject({
      method: "PUT",
      url: "/playback/state",
      headers: { ...bearer(account.session.tokens.accessToken), ...XSP },
      payload: putBody({ sessionId: sessionA }),
    });
    assert.equal(initial.statusCode, 200);

    t.clock.advance(1000);
    const handoff = await t.app.inject({
      method: "PUT",
      url: "/playback/state",
      headers: { ...bearer(b.session.tokens.accessToken), ...XSP },
      payload: putBody({
        sessionId: sessionB,
        at: formatIso(t.clock.now()),
        handoffFrom: { deviceId: account.device.id, sessionId: sessionA },
      }),
    });
    assert.equal(handoff.statusCode, 200);
    const handoffResult = json(handoff) as unknown as PlaybackPutResult;
    assert.equal(handoffResult.applied, true);

    const getAfterHandoff = await t.app.inject({
      method: "GET",
      url: "/playback/state",
      headers: { ...bearer(b.session.tokens.accessToken), ...XSP },
    });
    const stateAfterHandoff = (json(getAfterHandoff) as unknown as PlaybackStateResponse).state;
    assert.ok(stateAfterHandoff);
    assert.deepEqual(stateAfterHandoff.handoffFrom, {
      deviceId: account.device.id,
      sessionId: sessionA,
      at: formatIso(t.clock.now()),
    });

    // A still believes it is playing under its old session: its own update is refused with handed_off.
    t.clock.advance(1000);
    const staleA = await t.app.inject({
      method: "PUT",
      url: "/playback/state",
      headers: { ...bearer(account.session.tokens.accessToken), ...XSP },
      payload: putBody({ sessionId: sessionA, at: formatIso(t.clock.now()), queue: undefined }),
    });
    assert.equal(staleA.statusCode, 200);
    const staleResult = json(staleA) as unknown as PlaybackPutResult;
    assert.equal(staleResult.applied, false);
    assert.equal(staleResult.reason, "handed_off");
  });

  test("an invalid queue item (bad videoId) is 400 invalid_request", async () => {
    const account = await createAccount(t.ctx);
    const response = await t.app.inject({
      method: "PUT",
      url: "/playback/state",
      headers: { ...bearer(account.session.tokens.accessToken), ...XSP },
      payload: putBody({ queue: [{ videoId: "not-a-valid-id!!" }] }),
    });
    assert.equal(response.statusCode, 400);
    assert.equal(json(response).code, "invalid_request");
  });

  test("an index outside the reused stored queue is 400 invalid_request", async () => {
    const account = await createAccount(t.ctx);
    await t.app.inject({
      method: "PUT",
      url: "/playback/state",
      headers: { ...bearer(account.session.tokens.accessToken), ...XSP },
      payload: putBody(), // queue of length 1
    });
    const response = await t.app.inject({
      method: "PUT",
      url: "/playback/state",
      headers: { ...bearer(account.session.tokens.accessToken), ...XSP },
      payload: putBody({ queue: undefined, index: 5 }),
    });
    assert.equal(response.statusCode, 400);
    assert.equal(json(response).code, "invalid_request");
  });

  test("413 payload_too_large over the 128 KiB body limit (API §1.9)", async () => {
    const account = await createAccount(t.ctx);
    const response = await t.app.inject({
      method: "PUT",
      url: "/playback/state",
      headers: { ...bearer(account.session.tokens.accessToken), ...XSP },
      payload: putBody({ queue: [{ videoId: VALID_TRACK.videoId, title: "x".repeat(200_000) }] }),
    });
    assert.equal(response.statusCode, 413);
    assert.equal(json(response).code, "payload_too_large");
  });

  test("5 concurrent PUTs from the same device each win a distinct, ever-growing rev", async () => {
    const account = await createAccount(t.ctx);
    // Seed the row first: the 5 concurrent requests below then race as CAS UPDATEs of an existing row.
    await t.app.inject({
      method: "PUT",
      url: "/playback/state",
      headers: { ...bearer(account.session.tokens.accessToken), ...XSP },
      payload: putBody(),
    });

    // DESIGN §3.12.3's CAS gives each *request* up to 3 attempts, then `503 server_busy`; API §1.8 documents PUT
    // /playback/state as safe to retry automatically. With genuine PostgreSQL concurrency (unlike SQLite's single
    // writer), 5 requests racing the same row can occasionally exhaust one request's 3 attempts even though no
    // write was lost — the client's documented retry is what makes every one of the 5 logical writes land with a
    // distinct rev, which is what this test checks.
    async function putWithRetry(positionMs: number): Promise<PlaybackPutResult> {
      for (let attempt = 0; attempt < 5; attempt++) {
        const response = await t.app.inject({
          method: "PUT",
          url: "/playback/state",
          headers: { ...bearer(account.session.tokens.accessToken), ...XSP },
          payload: putBody({ queue: undefined, positionMs }),
        });
        if (response.statusCode === 200) return json(response) as unknown as PlaybackPutResult;
        assert.equal(response.statusCode, 503, response.body);
        assert.equal(json(response).code, "server_busy");
      }
      throw new Error("putWithRetry: exhausted its own (generous) retry budget");
    }

    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => putWithRetry(i * 1000)));
    for (const result of results) assert.equal(result.applied, true);
    const revs = results.map((result) => result.rev);
    assert.equal(new Set(revs).size, 5, "every write got its own rev");

    const getResponse = await t.app.inject({
      method: "GET",
      url: "/playback/state",
      headers: { ...bearer(account.session.tokens.accessToken), ...XSP },
    });
    const finalRev = (json(getResponse) as unknown as PlaybackStateResponse).state?.rev;
    assert.equal(finalRev, Math.max(...(revs as number[])));
  });
});

describe("DELETE /playback/state", () => {
  test("204, tombstones the row, publishes cleared:true, and rev keeps growing across DELETE then PUT", async () => {
    const account = await createAccount(t.ctx);
    const other = await secondDevice(t, account.user.id);
    const watcher = watch(t.ctx, account.user.id, other.device.id);

    const created = await t.app.inject({
      method: "PUT",
      url: "/playback/state",
      headers: { ...bearer(account.session.tokens.accessToken), ...XSP },
      payload: putBody(),
    });
    const revAfterPut = (json(created) as unknown as PlaybackPutResult).rev;
    await sleep(COALESCE_WINDOW_MS);

    const del = await t.app.inject({
      method: "DELETE",
      url: "/playback/state",
      headers: { ...bearer(account.session.tokens.accessToken), ...XSP },
    });
    assert.equal(del.statusCode, 204);
    assert.equal(del.body, "");

    const cleared = watcher.events.at(-1);
    assert.ok(cleared);
    const clearedPayload = cleared.payload as { rev: number; cleared: boolean; state: unknown };
    assert.equal(clearedPayload.cleared, true);
    assert.equal(clearedPayload.state, null);
    assert.ok(clearedPayload.rev > revAfterPut!);

    const getAfterDelete = await t.app.inject({
      method: "GET",
      url: "/playback/state",
      headers: { ...bearer(account.session.tokens.accessToken), ...XSP },
    });
    assert.equal((json(getAfterDelete) as unknown as PlaybackStateResponse).state, null);

    t.clock.advance(1000);
    const newPut = await t.app.inject({
      method: "PUT",
      url: "/playback/state",
      headers: { ...bearer(account.session.tokens.accessToken), ...XSP },
      payload: putBody({ at: formatIso(t.clock.now()) }),
    });
    const revAfterNewPut = (json(newPut) as unknown as PlaybackPutResult).rev;
    assert.ok(revAfterNewPut! > clearedPayload.rev, "rev after a new PUT is strictly greater than after DELETE (m18)");

    watcher.unregister();
  });

  test("DELETE with no prior row still answers 204", async () => {
    const account = await createAccount(t.ctx);
    const response = await t.app.inject({
      method: "DELETE",
      url: "/playback/state",
      headers: { ...bearer(account.session.tokens.accessToken), ...XSP },
    });
    assert.equal(response.statusCode, 204);
  });
});

describe("features and X-Sync-Protocol", () => {
  test("/server/info declares playback (API §4.2)", async () => {
    const response = await t.app.inject({ method: "GET", url: "/server/info" });
    const body = json(response) as { features: { playback?: { version: number } } };
    assert.deepEqual(body.features.playback, { version: 1 });
  });

  test("missing X-Sync-Protocol on GET is 400; unsupported version is 409", async () => {
    const account = await createAccount(t.ctx);
    const missing = await t.app.inject({
      method: "GET",
      url: "/playback/state",
      headers: bearer(account.session.tokens.accessToken),
    });
    assert.equal(missing.statusCode, 400);
    const unsupported = await t.app.inject({
      method: "GET",
      url: "/playback/state",
      headers: { ...bearer(account.session.tokens.accessToken), "x-sync-protocol": "99" },
    });
    assert.equal(unsupported.statusCode, 409);
    assert.equal(json(unsupported).code, "protocol_unsupported");
  });
});
