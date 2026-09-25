/**
 * The `server` module on both dialects (API §4.2, DESIGN §3.15, PLAN M0 acceptance "/server/info и /health
 * соответствуют API; при restore_pending=1 старт меняет epoch всем пользователям и снимает флаг"):
 * server identity, the restore epoch rotation, readiness and liveness, discovery, the landing page, `/openapi.json`,
 * `/docs`, CORS of the public routes, compression and draining.
 */
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { after, before, describe, test } from "node:test";
import { generateOpenapi } from "../../../scripts/gen-openapi.ts";
import { ServerInfo } from "../../contract/server.ts";
import { SYNC_OP_KINDS } from "../../contract/sync.ts";
import { API_MD } from "../../test/contract/api-table.ts";
import { createUser } from "../../test/factories.ts";
import { assertError, createTestApp, json, TEST_T0 } from "../../test/test-app.ts";
import type { TestApp } from "../../test/test-app.ts";
import { DAY_MS } from "../../lib/clock.ts";
import { formatIso } from "../../lib/time.ts";
import { deviceLinkingFeature, FEATURE_V1, syncFeature } from "./features.ts";
import { readMeta, upsertMeta } from "./server.repository.ts";
import { applyPendingRestore, checkReadiness, initServerIdentity } from "./server.service.ts";

let t: TestApp;

before(async () => {
  t = await createTestApp({ env: { APP_VERSION: "0.1.0", GIT_SHA: "3f9c2ab1d0e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8" } });
});

after(async () => {
  await t.close();
});

/** The keys of the `/server/info` example of API §4.2, in order. */
function exampleServerInfo(): Record<string, unknown> {
  const start = API_MD.indexOf('{"software":"melogold-server"');
  const end = API_MD.indexOf("\n```", start);
  return JSON.parse(API_MD.slice(start, end)) as Record<string, unknown>;
}

describe("server identity and restore (DESIGN §3.15)", () => {
  test("server_id and created_at are created once", async () => {
    const again = await initServerIdentity(t.db, TEST_T0 + DAY_MS);
    assert.equal(again, t.ctx.serverId);
    assert.equal(await t.db.read((q) => readMeta(q, "created_at")), String(TEST_T0));
  });

  test("restore_pending=1 rotates every epoch in batches, opens the grace window and clears the flag", async () => {
    const users = await Promise.all([1, 2, 3, 4, 5].map(() => createUser(t.db, { now: TEST_T0 })));
    await t.db.write((q) => upsertMeta(q, "restore_pending", "1"));
    let next = 0;
    const epochs = ["0000000a", "0000000b", "0000000c", "0000000d", "0000000e", "0000000f", "00000010"];
    const warnings: string[] = [];
    const now = TEST_T0 + 1000;
    const outcome = await applyPendingRestore(t.db, {
      now,
      graceDays: 3,
      batchSize: 2,
      log: { warn: (_details, message) => warnings.push(message) },
      epoch: () => epochs[next++] ?? "ffffffff",
    });
    assert.ok(outcome !== null);
    assert.equal(outcome.graceUntil, now + 3 * DAY_MS);
    const heads = await t.db.read((q) =>
      q.selectFrom("sync_heads").select(["user_id", "epoch", "updated_at"]).execute(),
    );
    assert.equal(outcome.rotatedUsers, heads.length);
    for (const user of users) {
      const head = heads.find((row) => row.user_id === user.id);
      assert.ok(head && head.epoch !== user.epoch && epochs.includes(head.epoch), user.id);
      assert.equal(head.updated_at, now);
    }
    assert.equal(new Set(heads.map((head) => head.epoch)).size, heads.length, "every user gets its own epoch");
    assert.equal(await t.db.read((q) => readMeta(q, "restore_pending")), null);
    assert.equal(await t.db.read((q) => readMeta(q, "restore_refresh_grace_until")), String(now + 3 * DAY_MS));
    assert.equal(warnings.length, 1);

    assert.equal(await applyPendingRestore(t.db, { now, graceDays: 3, log: { warn: () => undefined } }), null);
  });

  test("any value but '1' is not a pending restore", async () => {
    await t.db.write((q) => upsertMeta(q, "restore_pending", "0"));
    assert.equal(await applyPendingRestore(t.db, { now: TEST_T0, graceDays: 3, log: { warn: () => undefined } }), null);
    await t.db.write((q) => q.deleteFrom("server_meta").where("key", "=", "restore_pending").execute());
  });
});

describe("GET /health and /health/live (API §4.2)", () => {
  test("ready: status, version and dialect", async () => {
    const response = await t.app.inject({ method: "GET", url: "/health" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(json(response), { status: "ok", version: "0.1.0", db: t.db.dialect });
    assert.equal(response.headers["access-control-allow-origin"], "*");
    assert.equal(response.headers["cache-control"], "no-store");
    const live = await t.app.inject({ method: "GET", url: "/health/live" });
    assert.deepEqual([live.statusCode, json(live)], [200, { status: "ok" }]);
  });

  test("no database or a slow one → 503 unavailable", async () => {
    const base = { env: t.ctx.env, lifecycle: t.ctx.lifecycle, log: t.ctx.log };
    const failing = { ...t.db, run: () => Promise.reject(new Error("connection refused")) };
    await assert.rejects(checkReadiness({ ...base, db: failing }), { code: "unavailable" });
    const hanging = { ...t.db, run: () => new Promise<never>(() => undefined) };
    await assert.rejects(checkReadiness({ ...base, db: hanging }, 50), { code: "unavailable" });
  });
});

/** `features` of `/server/info` with every module registered (M1–M2, lyrics) and the default env. */
const ALL_FEATURES = {
  sync: syncFeature(SYNC_OP_KINDS),
  playback: FEATURE_V1,
  deviceLinking: deviceLinkingFeature(300),
  recoveryCode: FEATURE_V1,
  export: FEATURE_V1,
  accountDeletion: FEATURE_V1,
  lyrics: FEATURE_V1,
};

describe("GET /server/info (API §4.2)", () => {
  test("every field of API §4.2, limits from env, public cache, CORS *", async () => {
    const response = await t.app.inject({ method: "GET", url: "/server/info", headers: { origin: "https://x.test" } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["cache-control"], "public, max-age=60");
    assert.equal(response.headers["access-control-allow-origin"], "*");
    const body = json(response);
    ServerInfo.parse(body);
    const example = exampleServerInfo();
    assert.deepEqual(Object.keys(body), Object.keys(example));
    assert.equal(body.software, "melogold-server");
    assert.equal(body.version, "0.1.0");
    assert.equal(body.revision, "3f9c2ab");
    assert.deepEqual([body.apiVersion, body.minApiVersion], [1, 1]);
    assert.equal(body.serverId, t.ctx.serverId);
    assert.equal(body.instanceName, "Melogold");
    assert.equal(body.publicUrl, null);
    assert.equal(body.secureTransport, false);
    assert.equal(body.serverTime, formatIso(t.clock.now()));
    assert.deepEqual(body.features, ALL_FEATURES, "every module declares its features; PoW is off by default");
    assert.deepEqual(body.limits, example.limits, "default env gives the limits of the example");
    assert.deepEqual(body.links, {
      source: "https://github.com/melogold-app/melogoldServer/tree/3f9c2ab1d0e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8",
      privacy: null,
      contact: null,
    });
  });

  test("registration: first is open until the first user exists", async () => {
    const info = async () => json(await t.app.inject({ method: "GET", url: "/server/info" }));
    assert.equal((await info()).registration, "open");
    await createUser(t.db, { firstUser: true });
    assert.equal((await info()).registration, "closed");
  });
});

describe("the application around the server module", () => {
  test("declared features appear in /server/info; https behind a trusted proxy is secure transport", async () => {
    const other = await createTestApp({
      env: {
        TRUST_PROXY: "127.0.0.1/32",
        REGISTRATION: "closed",
        PUBLIC_URL: "https://music.example.com",
        MAX_DEVICES_PER_USER: "0",
      },
    });
    try {
      const response = await other.app.inject({
        method: "GET",
        url: "/server/info",
        headers: { "x-forwarded-proto": "https" },
      });
      const body = json(response);
      // What the real modules declare on their own
      assert.deepEqual(body.features, ALL_FEATURES);
      assert.equal(body.secureTransport, true);
      assert.equal(body.registration, "closed");
      assert.equal(body.publicUrl, "https://music.example.com");
      assert.equal((body.limits as { account: { maxDevices: unknown } }).account.maxDevices, null);

      const landing = await other.app.inject({ method: "GET", url: "/", headers: { "accept-language": "ru-RU" } });
      assert.equal(landing.statusCode, 200);
      assert.match(String(landing.headers["content-type"]), /^text\/html/);
      assert.match(String(landing.headers["content-security-policy"]), /default-src 'none'/);
      assert.ok(
        landing.body.includes(
          `melogold://server?v=1&amp;url=https%3A%2F%2Fmusic.example.com&amp;sid=${other.ctx.serverId}`,
        ),
      );
      assert.ok(landing.body.includes("Открыть в Melogold"));
    } finally {
      await other.close();
    }
  });

  test("/openapi.json is the generated document; /docs exists only with OPENAPI_DOCS_UI", async () => {
    const response = await t.app.inject({ method: "GET", url: "/openapi.json" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(json(response), (await generateOpenapi()).document);
    assertError(await t.app.inject({ method: "GET", url: "/docs" }), 404, "not_found");

    const withDocs = await createTestApp({ env: { OPENAPI_DOCS_UI: "true" } });
    try {
      const docs = await withDocs.app.inject({ method: "GET", url: "/docs" });
      assert.equal(docs.statusCode, 200);
      assert.ok(docs.body.includes("<code>getServerInfo</code>"));
    } finally {
      await withDocs.close();
    }
  });

  test("JSON of at least 1 KiB is gzipped on request (HTTP_COMPRESSION)", async () => {
    const response = await t.app.inject({
      method: "GET",
      url: "/openapi.json",
      headers: { "accept-encoding": "gzip" },
    });
    assert.equal(response.headers["content-encoding"], "gzip");
    const document = JSON.parse(gunzipSync(response.rawPayload).toString("utf8")) as Record<string, unknown>;
    assert.equal(document.openapi, "3.0.3");
    const small = await t.app.inject({ method: "GET", url: "/health/live", headers: { "accept-encoding": "gzip" } });
    assert.equal(small.headers["content-encoding"], undefined);
  });

  test("CORS: CORS_ORIGINS decides for every route but the discovery ones", async () => {
    const preflight = (app: TestApp, origin: string) =>
      app.app.inject({
        method: "OPTIONS",
        url: "/auth/me",
        headers: { origin, "access-control-request-method": "GET", "access-control-request-headers": "authorization" },
      });
    const closed = await preflight(t, "https://web.example.com");
    assert.equal(closed.headers["access-control-allow-origin"], undefined);

    const open = await createTestApp({ env: { CORS_ORIGINS: "https://web.example.com" } });
    try {
      const allowed = await preflight(open, "https://web.example.com");
      assert.equal(allowed.statusCode, 204);
      assert.equal(allowed.headers["access-control-allow-origin"], "https://web.example.com");
      const denied = await preflight(open, "https://evil.example.com");
      assert.equal(denied.headers["access-control-allow-origin"], undefined);
      const unauthorized = await open.app.inject({
        method: "GET",
        url: "/auth/me",
        headers: { origin: "https://web.example.com" },
      });
      assertError(unauthorized, 401, "unauthorized");
      assert.equal(unauthorized.headers["access-control-allow-origin"], "https://web.example.com");
    } finally {
      await open.close();
    }
  });

  test("draining: new requests get 503 unavailable with Connection: close (ACAO * kept), liveness answers", async () => {
    const draining = await createTestApp();
    try {
      draining.ctx.lifecycle.startDraining();
      const origin = { origin: "https://web.example" };
      const health = await draining.app.inject({ method: "GET", url: "/health", headers: origin });
      const body = assertError(health, 503, "unavailable");
      assert.equal(body.retryAfterSeconds, 5);
      assert.equal(health.headers["retry-after"], "5");
      assert.equal(health.headers.connection, "close");
      assert.equal(health.headers["access-control-allow-origin"], "*");
      const info = await draining.app.inject({ method: "GET", url: "/server/info", headers: origin });
      assertError(info, 503, "unavailable");
      assert.equal(info.headers["access-control-allow-origin"], "*");
      const live = await draining.app.inject({ method: "GET", url: "/health/live", headers: origin });
      assert.equal(live.statusCode, 200);
      assert.equal(live.headers["access-control-allow-origin"], "*");
    } finally {
      await draining.close();
    }
  });

  test("app.close() closes the live streams (preClose → closeAll)", async () => {
    const closing = await createTestApp();
    const reasons: string[] = [];
    closing.ctx.live.register({
      userId: "0c3f6a2e-5d1b-4c7a-9e8f-1a2b3c4d5e6f",
      deviceId: "9b1e2f4a-7c3d-4e5f-8a9b-0c1d2e3f4a5b",
      authVersion: 1,
      expiresAt: TEST_T0 + 900_000,
      send: () => undefined,
      close: (reason) => reasons.push(reason),
    });
    await closing.close();
    assert.deepEqual(reasons, ["shutdown"]);
  });
});
