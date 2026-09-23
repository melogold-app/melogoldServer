/**
 * The HTTP infrastructure end to end through `app.inject`, on both dialects (the guard reads and writes the database):
 * the error contract, 404, body rules, sanitization, the guard steps of API §1.7, `X-Sync-Protocol`, the disk guard,
 * request ids and cache headers. Rate limits are in `rate-limit.int.test.ts`.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import fastify from "fastify";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Kysely } from "kysely";
import { z } from "zod";
import type { Database, Db } from "../db/index.ts";
import { ManualClock, MINUTE_MS } from "../lib/clock.ts";
import { newId } from "../lib/ids.ts";
import { LruSet } from "../lib/lru.ts";
import { issueSession, sessionConfig } from "../lib/session.ts";
import type { IssuedSession } from "../lib/session.ts";
import { hashToken, signAccessToken } from "../lib/tokens.ts";
import { TEST_DIALECT, createMigratedTestDatabase } from "../test/test-db.ts";
import type { TestDatabase } from "../test/test-db.ts";
import { requireAuth } from "./auth-guard.ts";
import { ALL_ERROR_CODES } from "./error-codes.ts";
import { AppError } from "./errors.ts";
import { fastifyServerOptions, registerHttpInfrastructure } from "./index.ts";

const T0 = Date.UTC(2026, 8, 23, 10, 0, 0);
const KEYS = { jwtAccess: Buffer.alloc(32, 11), refreshToken: Buffer.alloc(32, 12) };
const SESSION = sessionConfig({ ACCESS_TOKEN_TTL_SECONDS: 900, REFRESH_TOKEN_TTL_DAYS: 90 }, KEYS);

let database: TestDatabase;
let db: Db;

before(async () => {
  ({ database, db } = await createMigratedTestDatabase());
});

after(async () => {
  await db.destroy();
  await database.cleanup();
});

type AppOptions = {
  clock: ManualClock;
  diskFull?: { value: boolean };
  confirmed?: LruSet<string>;
};

async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = fastify(fastifyServerOptions({ LOG_LEVEL: "silent", TRUST_PROXY: [] }));
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const diskFull = options.diskFull ?? { value: false };
  await registerHttpInfrastructure(app, {
    env: { RATE_LIMIT_ENABLED: false },
    db,
    keys: KEYS,
    clock: options.clock,
    diskGuard: {
      assertWritable: () => {
        if (diskFull.value) throw new AppError("storage_full", { details: { retryAfterSeconds: 600 } });
      },
    },
    random: () => 0,
    ...(options.confirmed ? { confirmedRefreshIds: options.confirmed } : {}),
  });

  const routes = app.withTypeProvider<ZodTypeProvider>();
  routes.get("/auth/me", (request) => Promise.resolve({ auth: requireAuth(request) }));
  routes.get("/server/info", (_request, reply) => {
    void reply.header("cache-control", "public, max-age=60");
    return Promise.resolve({ ok: true });
  });
  routes.get("/health", () => Promise.resolve({ status: "ok" }));
  routes.post(
    "/auth/login",
    { schema: { body: z.object({ login: z.string(), device: z.object({ name: z.string() }).optional() }) } },
    (request) => Promise.resolve({ login: request.body.login, device: request.body.device ?? null }),
  );
  routes.post(
    "/sync",
    {
      schema: {
        body: z.object({
          ops: z.array(z.object({ n: z.number().int().min(0).max(2_147_483_647), text: z.string().optional() })),
        }),
      },
    },
    (request) => Promise.resolve({ count: request.body.ops.length, ops: request.body.ops }),
  );
  routes.put("/playback/state", { schema: { body: z.object({}) } }, () => Promise.resolve({ ok: true }));
  routes.patch(
    "/auth/me/devices/:deviceId",
    {
      schema: {
        params: z.object({ deviceId: z.uuid({ version: "v4" }) }),
        body: z.object({ name: z.string().nullable() }),
      },
    },
    (request) => Promise.resolve({ id: request.params.deviceId }),
  );
  routes.get("/test/boom", { config: { auth: "public" } }, () => Promise.reject(new Error("secret detail /data")));
  routes.get("/test/db-busy", { config: { auth: "public" } }, () =>
    Promise.reject(Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" })),
  );
  routes.get("/test/stub", { config: { auth: "public" } }, () => Promise.reject(new AppError("not_implemented")));
  // A route plugin registered after the infrastructure inherits the error handler (API §2.1).
  await app.register((child, _options, done) => {
    child.get("/test/child", { config: { auth: "public" } }, () =>
      Promise.reject(new AppError("device_limit_reached", { details: { deviceLimit: 20, deviceCount: 20 } })),
    );
    done();
  });
  await app.ready();
  return app;
}

async function insertUser(q: Kysely<Database>, userId: string): Promise<void> {
  await q
    .insertInto("users")
    .values({
      id: userId,
      login: `u${userId.slice(0, 8)}`,
      password_hash: "$argon2id$stub",
      password_changed_at: T0,
      recovery_code_hash: "0".repeat(64),
      recovery_code_created_at: T0,
      created_at: T0,
      updated_at: T0,
    })
    .execute();
}

async function insertDevice(q: Kysely<Database>, userId: string, deviceId: string, lastSeenAt = T0): Promise<void> {
  await q
    .insertInto("devices")
    .values({
      id: deviceId,
      user_id: userId,
      hwid_hash: hashToken(deviceId),
      reported_name: "Pixel",
      platform: "android",
      linked_via: "register",
      created_at: T0,
      last_seen_at: lastSeenAt,
    })
    .execute();
}

type Account = { userId: string; deviceId: string; session: IssuedSession };

async function account(now = T0): Promise<Account> {
  const userId = newId();
  const deviceId = newId();
  const session = await db.write(async (q) => {
    await insertUser(q, userId);
    await insertDevice(q, userId, deviceId);
    return issueSession(q, { userId, deviceId, authVersion: 1, now }, SESSION);
  });
  return { userId, deviceId, session };
}

/** Sends raw bytes to a listening server and returns everything it answers until it closes the connection. */
async function rawExchange(port: number, request: string): Promise<string> {
  const socket = connect({ host: "127.0.0.1", port });
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  socket.on("error", () => undefined);
  await once(socket, "connect");
  socket.write(request);
  await once(socket, "close");
  return Buffer.concat(chunks).toString("utf8");
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const json = (response: LightMyRequestResponse) => response.json<Record<string, unknown>>();

/** API §2.1: the four envelope keys (then details only), a registered code, never 200. */
function assertError(response: LightMyRequestResponse, status: number, code: string): Record<string, unknown> {
  const body = json(response);
  assert.equal(response.statusCode, status, `${code}: ${response.body}`);
  assert.equal(body.code, code);
  assert.deepEqual(Object.keys(body).slice(0, 4), ["statusCode", "error", "message", "code"]);
  assert.equal(body.statusCode, status);
  assert.equal(body.error, body.message);
  assert.ok((ALL_ERROR_CODES as readonly string[]).includes(code));
  assert.match(String(response.headers["content-type"]), /^application\/json/);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.ok(response.headers["x-request-id"]);
  return body;
}

describe(`HTTP infrastructure (${TEST_DIALECT})`, () => {
  let clock: ManualClock;
  let app: FastifyInstance;
  const diskFull = { value: false };

  before(async () => {
    clock = new ManualClock(T0);
    app = await buildApp({ clock, diskFull });
  });

  after(async () => {
    await app.close();
  });

  describe("error contract and 404", () => {
    test("unknown route → 404 not_found, also without a token and with any body", async () => {
      assertError(await app.inject({ method: "GET", url: "/nope" }), 404, "not_found");
      assertError(
        await app.inject({ method: "POST", url: "/nope", headers: { "content-type": "text/plain" }, payload: "{" }),
        404,
        "not_found",
      );
      assertError(await app.inject({ method: "GET", url: "/sync" }), 404, "not_found");
    });

    test("route without a token → 401 unauthorized; HEAD too", async () => {
      assertError(await app.inject({ method: "GET", url: "/auth/me" }), 401, "unauthorized");
      assert.equal((await app.inject({ method: "HEAD", url: "/auth/me" })).statusCode, 401);
    });

    test("stub → 501; bug → 500 with the generic message; busy database → 503 with Retry-After", async () => {
      assertError(await app.inject({ method: "GET", url: "/test/stub" }), 501, "not_implemented");
      const boom = assertError(await app.inject({ method: "GET", url: "/test/boom" }), 500, "internal_error");
      assert.equal(boom.message, "Internal server error");
      assert.doesNotMatch(JSON.stringify(boom), /secret|\/data/);
      const busy = await app.inject({ method: "GET", url: "/test/db-busy" });
      assertError(busy, 503, "server_busy");
      assert.equal(busy.headers["retry-after"], "1");
      assert.equal(json(busy).retryAfterSeconds, 1);
    });

    test("route plugins registered later use the same handler", async () => {
      const body = assertError(await app.inject({ method: "GET", url: "/test/child" }), 409, "device_limit_reached");
      assert.equal(body.deviceLimit, 20);
      assert.equal(body.deviceCount, 20);
    });
  });

  describe("request bodies (API §1.2, §1.4, §1.9)", () => {
    /** `contentType: null` sends no Content-Type header at all. */
    const login = (payload: string | undefined, contentType: string | null = "application/json") =>
      app.inject({
        method: "POST",
        url: "/auth/login",
        ...(contentType === null ? {} : { headers: { "content-type": contentType } }),
        ...(payload === undefined ? {} : { payload }),
      });

    test("JSON only: other or missing content type → 415", async () => {
      assertError(await login('{"login":"a"}', "text/plain"), 415, "unsupported_media_type");
      assertError(await login('{"login":"a"}', "application/x-www-form-urlencoded"), 415, "unsupported_media_type");
      assertError(await login('{"login":"a"}', "application/json; charset=iso-8859-1"), 415, "unsupported_media_type");
      assertError(await login(undefined, null), 415, "unsupported_media_type");
      assertError(await login('{"login":"a"}', null), 415, "unsupported_media_type");
      assert.equal((await login('{"login":"a"}', "application/json; charset=utf-8")).statusCode, 200);
    });

    test("empty or malformed JSON → 400 invalid_json; not an object → 400 invalid_request", async () => {
      assertError(await login(""), 400, "invalid_json");
      assertError(await login("{"), 400, "invalid_json");
      assertError(await login('{"__proto__":{"x":1}}'), 400, "invalid_json");
      const array = assertError(await login("[]"), 400, "invalid_request");
      assert.ok(Array.isArray(array.issues));
    });

    test("body over the route limit → 413 (16 KiB on /auth/**, 4 MiB on /sync)", async () => {
      const big = JSON.stringify({ login: "x".repeat(16 * 1024) });
      assertError(await login(big), 413, "payload_too_large");
      const ops = JSON.stringify({ ops: Array.from({ length: 2000 }, (_, n) => ({ n, text: "x".repeat(20) })) });
      assert.ok(ops.length > 64 * 1024);
      const sync = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { ...bearer((await account()).session.tokens.accessToken), "x-sync-protocol": "1" },
        payload: JSON.parse(ops) as object,
      });
      assert.equal(sync.statusCode, 200, sync.body);
    });

    test("M12: NUL and lone surrogates are sanitized before validation", async () => {
      const response = await login('{"login":"ma\\u0000xim\\ud800","device":{"name":"Pix\\u0000el\\udc00"}}');
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(json(response), { login: "maxim�", device: { name: "Pixel�" } });
    });

    test("M12: Int32 above 2^31−1 → 400 invalid_request with the path, not 500", async () => {
      const { session } = await account();
      const response = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { ...bearer(session.tokens.accessToken), "x-sync-protocol": "1" },
        payload: { ops: [{ n: 1 }, { n: 2_147_483_648 }] },
      });
      const body = assertError(response, 400, "invalid_request");
      assert.deepEqual(body.issues, [{ path: "ops.1.n", code: "too_big" }]);
    });

    test("bad path parameter → 400 invalid_request (API §3)", async () => {
      const { session } = await account();
      const response = await app.inject({
        method: "PATCH",
        url: "/auth/me/devices/not-a-uuid",
        headers: bearer(session.tokens.accessToken),
        payload: { name: null },
      });
      const body = assertError(response, 400, "invalid_request");
      assert.deepEqual(body.issues, [{ path: "params.deviceId", code: "invalid_format" }]);
    });
  });

  describe("guard (API §1.7)", () => {
    test("a valid token authenticates the device", async () => {
      const { userId, deviceId, session } = await account();
      const response = await app.inject({
        method: "GET",
        url: "/auth/me",
        headers: bearer(session.tokens.accessToken),
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(json(response).auth, {
        userId,
        deviceId,
        authVersion: 1,
        refreshId: session.refreshId,
        tokenIssuedAt: T0,
        tokenExpiresAt: T0 + 900_000,
      });
    });

    test("step 1: no Bearer credential → unauthorized", async () => {
      for (const authorization of ["Basic dXNlcjpwYXNz", "Bearer", "Bearer  ", "Token abc", ""]) {
        assertError(
          await app.inject({ method: "GET", url: "/auth/me", headers: { authorization } }),
          401,
          "unauthorized",
        );
      }
    });

    test("step 2: bad token → access_token_invalid; expired → access_token_expired", async () => {
      const { userId, deviceId, session } = await account();
      assertError(
        await app.inject({ method: "GET", url: "/auth/me", headers: bearer("garbage") }),
        401,
        "access_token_invalid",
      );
      const forged = signAccessToken({ sub: userId, did: deviceId, av: 1, rid: session.refreshId }, Buffer.alloc(32), {
        now: T0,
        ttlSeconds: 900,
      });
      assertError(
        await app.inject({ method: "GET", url: "/auth/me", headers: bearer(forged.token) }),
        401,
        "access_token_invalid",
      );
      clock.set(T0 + 900_000);
      try {
        assertError(
          await app.inject({ method: "GET", url: "/auth/me", headers: bearer(session.tokens.accessToken) }),
          401,
          "access_token_expired",
        );
      } finally {
        clock.set(T0);
      }
    });

    test("step 3: removed device, deleted user or foreign device → session_revoked", async () => {
      const removed = await account();
      await db.run((q) => q.deleteFrom("devices").where("id", "=", removed.deviceId).execute());
      assertError(
        await app.inject({ method: "GET", url: "/auth/me", headers: bearer(removed.session.tokens.accessToken) }),
        401,
        "session_revoked",
      );

      const deleted = await account();
      await db.run((q) => q.updateTable("users").set({ deleted_at: T0 }).where("id", "=", deleted.userId).execute());
      assertError(
        await app.inject({ method: "GET", url: "/auth/me", headers: bearer(deleted.session.tokens.accessToken) }),
        401,
        "session_revoked",
      );

      const mine = await account();
      const theirs = await account();
      const crossed = signAccessToken(
        { sub: mine.userId, did: theirs.deviceId, av: 1, rid: mine.session.refreshId },
        KEYS.jwtAccess,
        { now: T0, ttlSeconds: 900 },
      );
      assertError(
        await app.inject({ method: "GET", url: "/auth/me", headers: bearer(crossed.token) }),
        401,
        "session_revoked",
      );
    });

    test("step 4: another auth_version → access_token_expired", async () => {
      const { userId, session } = await account();
      await db.run((q) => q.updateTable("users").set({ auth_version: 2 }).where("id", "=", userId).execute());
      assertError(
        await app.inject({ method: "GET", url: "/auth/me", headers: bearer(session.tokens.accessToken) }),
        401,
        "access_token_expired",
      );
    });

    test("step 5: the first use confirms rid once per process", async () => {
      const confirmed = new LruSet<string>(100);
      const own = await buildApp({ clock, confirmed });
      try {
        const { session } = await account();
        const readConfirmed = () =>
          db.run((q) =>
            q
              .selectFrom("refresh_tokens")
              .select("confirmed_at")
              .where("id", "=", session.refreshId)
              .executeTakeFirstOrThrow(),
          );
        assert.equal((await readConfirmed()).confirmed_at, null);
        clock.set(T0 + 1000);
        await own.inject({ method: "GET", url: "/auth/me", headers: bearer(session.tokens.accessToken) });
        assert.equal((await readConfirmed()).confirmed_at, T0 + 1000);
        assert.equal(confirmed.has(session.refreshId), true);

        // Remembered: no second write, even if the column were reset.
        await db.run((q) =>
          q.updateTable("refresh_tokens").set({ confirmed_at: null }).where("id", "=", session.refreshId).execute(),
        );
        await own.inject({ method: "GET", url: "/auth/me", headers: bearer(session.tokens.accessToken) });
        assert.equal((await readConfirmed()).confirmed_at, null);

        // A new process confirms again, and never overwrites an earlier confirmation.
        confirmed.clear();
        clock.set(T0 + 2000);
        await own.inject({ method: "GET", url: "/auth/me", headers: bearer(session.tokens.accessToken) });
        assert.equal((await readConfirmed()).confirmed_at, T0 + 2000);
        confirmed.clear();
        clock.set(T0 + 3000);
        await own.inject({ method: "GET", url: "/auth/me", headers: bearer(session.tokens.accessToken) });
        assert.equal((await readConfirmed()).confirmed_at, T0 + 2000);
      } finally {
        clock.set(T0);
        await own.close();
      }
    });

    test("step 6: last_seen_at is written at most once per 5 minutes", async () => {
      const { deviceId, session } = await account();
      const lastSeen = async () =>
        (
          await db.run((q) =>
            q.selectFrom("devices").select("last_seen_at").where("id", "=", deviceId).executeTakeFirstOrThrow(),
          )
        ).last_seen_at;
      const call = () => app.inject({ method: "GET", url: "/auth/me", headers: bearer(session.tokens.accessToken) });
      try {
        clock.set(T0 + 4 * MINUTE_MS);
        await call();
        assert.equal(await lastSeen(), T0);
        clock.set(T0 + 5 * MINUTE_MS);
        await call();
        assert.equal(await lastSeen(), T0 + 5 * MINUTE_MS);
        clock.set(T0 + 9 * MINUTE_MS);
        await call();
        assert.equal(await lastSeen(), T0 + 5 * MINUTE_MS);
      } finally {
        clock.set(T0);
      }
    });
  });

  describe("X-Sync-Protocol and storage", () => {
    test("missing → 400, unsupported → 409 with the range, 1 → 200", async () => {
      const { session } = await account();
      const sync = (headers: Record<string, string>) =>
        app.inject({
          method: "POST",
          url: "/sync",
          headers: { ...bearer(session.tokens.accessToken), ...headers },
          payload: { ops: [] },
        });
      const missing = assertError(await sync({}), 400, "invalid_request");
      assert.deepEqual(missing.issues, [{ path: "headers.x-sync-protocol", code: "invalid_type" }]);
      assertError(await sync({ "x-sync-protocol": "1.5" }), 400, "invalid_request");
      const unsupported = assertError(await sync({ "x-sync-protocol": "2" }), 409, "protocol_unsupported");
      assert.equal(unsupported.minProtocol, 1);
      assert.equal(unsupported.maxProtocol, 1);
      assert.equal((await sync({ "x-sync-protocol": "1" })).statusCode, 200);
    });

    test("low disk: 503 storage_full for /sync with ops and PUT playback; pull and reads work", async () => {
      const { session } = await account();
      const headers = { ...bearer(session.tokens.accessToken), "x-sync-protocol": "1" };
      diskFull.value = true;
      try {
        const full = await app.inject({ method: "POST", url: "/sync", headers, payload: { ops: [{ n: 1 }] } });
        assertError(full, 503, "storage_full");
        assert.equal(full.headers["retry-after"], "600");
        assertError(
          await app.inject({ method: "PUT", url: "/playback/state", headers, payload: {} }),
          503,
          "storage_full",
        );
        assert.equal(
          (await app.inject({ method: "POST", url: "/sync", headers, payload: { ops: [] } })).statusCode,
          200,
        );
        assert.equal((await app.inject({ method: "GET", url: "/auth/me", headers })).statusCode, 200);
      } finally {
        diskFull.value = false;
      }
      assert.equal(
        (await app.inject({ method: "POST", url: "/sync", headers, payload: { ops: [{ n: 1 }] } })).statusCode,
        200,
      );
    });
  });

  describe("headers (API §1.2)", () => {
    test("X-Request-Id: a valid one is echoed, otherwise generated", async () => {
      const kept = await app.inject({ method: "GET", url: "/health", headers: { "x-request-id": "client-req-0001" } });
      assert.equal(kept.headers["x-request-id"], "client-req-0001");
      const replaced = await app.inject({ method: "GET", url: "/health", headers: { "x-request-id": "bad id" } });
      assert.match(String(replaced.headers["x-request-id"]), /^[0-9a-f-]{36}$/);
      const generated = await app.inject({ method: "GET", url: "/nope" });
      assert.match(String(generated.headers["x-request-id"]), /^[0-9a-f-]{36}$/);
    });

    test("Cache-Control: no-store, except where the route sets its own", async () => {
      assert.equal((await app.inject({ method: "GET", url: "/health" })).headers["cache-control"], "no-store");
      assert.equal(
        (await app.inject({ method: "GET", url: "/server/info" })).headers["cache-control"],
        "public, max-age=60",
      );
    });

    test("URLs rejected before routing (bad encoding, parameter over 100 chars) → the envelope with X-Request-Id", async () => {
      const cases = [
        ["GET", "/%", "invalid_format"],
        ["PATCH", "/auth/me/devices/%zz", "invalid_format"],
        ["PATCH", `/auth/me/devices/${"a".repeat(101)}`, "too_big"],
      ] as const;
      for (const [method, url, issue] of cases) {
        const response = await app.inject({ method, url });
        const body = assertError(response, 400, "invalid_request");
        assert.deepEqual(body.issues, [{ path: "url", code: issue }], url);
        assert.match(String(response.headers["x-request-id"]), /^[0-9a-f-]{36}$/);
      }
      const kept = await app.inject({ method: "GET", url: "/%", headers: { "x-request-id": "client-req-0002" } });
      assert.equal(kept.headers["x-request-id"], "client-req-0002");
    });

    test("requests Node's parser rejects → 400 envelope on the socket, then the connection closes", async () => {
      const listening = await buildApp({ clock });
      try {
        await listening.listen({ host: "127.0.0.1", port: 0 });
        const { port } = listening.server.address() as AddressInfo;
        const exchanges = [
          [`GET /health HTTP/1.1\r\nHost: x\r\nX-Big: ${"a".repeat(17 * 1024)}\r\n\r\n`, "headers", "too_big"],
          ["HELLO\r\n\r\n", "request", "invalid_format"],
        ] as const;
        for (const [request, path, code] of exchanges) {
          const answer = await rawExchange(port, request);
          const [head = "", payload = ""] = answer.split("\r\n\r\n");
          const lines = head.split("\r\n");
          assert.equal(lines[0], "HTTP/1.1 400 Bad Request", answer);
          assert.ok(lines.includes("Cache-Control: no-store"), head);
          assert.ok(
            lines.some((line) => /^X-Request-Id: [0-9a-f-]{36}$/.test(line)),
            head,
          );
          const body = JSON.parse(payload) as Record<string, unknown>;
          assert.deepEqual(Object.keys(body), ["statusCode", "error", "message", "code", "issues"]);
          assert.equal(body.code, "invalid_request");
          assert.deepEqual(body.issues, [{ path, code }]);
        }
      } finally {
        await listening.close();
      }
    });
  });
});
