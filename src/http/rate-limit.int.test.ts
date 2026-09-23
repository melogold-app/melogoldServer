/**
 * Rate limits of API §1.10 through `app.inject`, both dialects (the `user`/`device` keys come from the guard):
 * keys `ip` (IPv6 /56), `user`, `rt`, `ps`, the 429 envelope with Retry-After, no limit on health, `TRUST_PROXY`,
 * and logs that carry `ipTag` but never an address, a query string or a secret.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import fastify from "fastify";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../db/index.ts";
import { ManualClock } from "../lib/clock.ts";
import { newId } from "../lib/ids.ts";
import { issueSession, sessionConfig } from "../lib/session.ts";
import { hashToken, newPollSecret } from "../lib/tokens.ts";
import { TEST_DIALECT, createMigratedTestDatabase } from "../test/test-db.ts";
import type { TestDatabase } from "../test/test-db.ts";
import { clientNet, isSecureTransport } from "./client-ip.ts";
import { fastifyServerOptions, registerHttpInfrastructure } from "./index.ts";
import type { LoggerOptions } from "./logging.ts";

const T0 = Date.now();
const KEYS = { jwtAccess: Buffer.alloc(32, 21), refreshToken: Buffer.alloc(32, 22) };
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

type Built = { app: FastifyInstance; logs: Record<string, unknown>[] };

async function buildApp(options: { trustProxy?: string[]; enabled?: boolean } = {}): Promise<Built> {
  const logs: Record<string, unknown>[] = [];
  const base = fastifyServerOptions({ LOG_LEVEL: "info", TRUST_PROXY: options.trustProxy ?? [] });
  const logger: LoggerOptions = {
    ...(base.logger as LoggerOptions),
    stream: {
      write: (line: string) => {
        logs.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  };
  const app = fastify({ ...base, logger });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await registerHttpInfrastructure(app, {
    env: { RATE_LIMIT_ENABLED: options.enabled ?? true },
    db,
    keys: KEYS,
    clock: new ManualClock(T0),
    diskGuard: { assertWritable: () => undefined },
  });
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const ok = () => Promise.resolve({ ok: true });
  routes.get("/auth/me", ok);
  routes.get("/health", ok);
  routes.post("/auth/login", { schema: { body: z.object({ login: z.string(), password: z.string() }) } }, ok);
  routes.post("/auth/refresh", { schema: { body: z.object({ refreshToken: z.string() }) } }, ok);
  routes.post("/auth/link/poll", { schema: { body: z.object({ pollSecret: z.string() }) } }, ok);
  routes.get("/test/ip", { config: { auth: "public" } }, (request) =>
    Promise.resolve({ ip: request.ip, net: clientNet(request.ip), secure: isSecureTransport(request) }),
  );
  await app.ready();
  return { app, logs };
}

async function account(): Promise<{ accessToken: string; refreshToken: string }> {
  const userId = newId();
  const deviceId = newId();
  const session = await db.write(async (q) => {
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
        last_seen_at: T0,
      })
      .execute();
    return issueSession(q, { userId, deviceId, authVersion: 1, now: T0 }, SESSION);
  });
  return { accessToken: session.tokens.accessToken, refreshToken: session.tokens.refreshToken };
}

/** Sends `count` requests and returns the status codes. */
async function burst(count: number, send: () => Promise<LightMyRequestResponse>): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < count; i++) statuses.push((await send()).statusCode);
  return statuses;
}

function assertRateLimited(response: LightMyRequestResponse, windowSeconds: number): void {
  assert.equal(response.statusCode, 429, response.body);
  const body = response.json<Record<string, unknown>>();
  assert.deepEqual(Object.keys(body), ["statusCode", "error", "message", "code", "retryAfterSeconds"]);
  assert.equal(body.code, "rate_limited");
  const retryAfter = Number(body.retryAfterSeconds);
  assert.ok(retryAfter >= 1 && retryAfter <= windowSeconds, `retryAfterSeconds ${retryAfter}`);
  assert.equal(response.headers["retry-after"], String(retryAfter));
}

describe(`rate limits (${TEST_DIALECT})`, () => {
  let built: Built;

  before(async () => {
    built = await buildApp();
  });

  after(async () => {
    await built.app.close();
  });

  test("POST /auth/login: 60 per 10 min per ip; IPv6 counted per /56", async () => {
    const { app } = built;
    const login = (remoteAddress: string) =>
      app.inject({ method: "POST", url: "/auth/login", remoteAddress, payload: { login: "a", password: "b" } });
    assert.ok((await burst(60, () => login("203.0.113.9"))).every((status) => status === 200));
    assertRateLimited(await login("203.0.113.9"), 600);
    assert.equal((await login("203.0.113.10")).statusCode, 200, "another IPv4 address");

    assert.ok((await burst(60, () => login("2001:db8:1:100::1"))).every((status) => status === 200));
    assertRateLimited(await login("2001:db8:1:1ff:abcd::2"), 600);
    assert.equal((await login("2001:db8:1:200::1")).statusCode, 200, "another /56");
  });

  test("Bearer default: 120 per minute per user", async () => {
    const { app } = built;
    const alice = await account();
    const bob = await account();
    const me = (token: string) =>
      app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${token}` } });
    assert.ok((await burst(120, () => me(alice.accessToken))).every((status) => status === 200));
    assertRateLimited(await me(alice.accessToken), 60);
    assert.equal((await me(bob.accessToken)).statusCode, 200, "another user");
    assert.equal((await app.inject({ method: "GET", url: "/auth/me" })).statusCode, 401, "the guard runs first");
  });

  test("POST /auth/refresh: 30 per minute per device of an authentic token, else per ip", async () => {
    const { app } = built;
    const alice = await account();
    const bob = await account();
    const refresh = (refreshToken: string, remoteAddress = "198.51.100.1") =>
      app.inject({ method: "POST", url: "/auth/refresh", remoteAddress, payload: { refreshToken } });
    assert.ok((await burst(30, () => refresh(alice.refreshToken))).every((status) => status === 200));
    assertRateLimited(await refresh(alice.refreshToken, "198.51.100.99"), 60);
    assert.equal((await refresh(bob.refreshToken)).statusCode, 200, "another device, same ip");

    const forged = `${alice.refreshToken.slice(0, -2)}AA`;
    assert.ok((await burst(30, () => refresh(forged, "198.51.100.7"))).every((status) => status === 200));
    assertRateLimited(await refresh("not-a-token", "198.51.100.7"), 60);
    assert.equal((await refresh("not-a-token", "198.51.100.8")).statusCode, 200);
  });

  test("POST /auth/link/poll: 60 per minute per poll secret", async () => {
    const { app } = built;
    const secret = newPollSecret();
    const poll = (pollSecret: string) =>
      app.inject({ method: "POST", url: "/auth/link/poll", remoteAddress: "192.0.2.50", payload: { pollSecret } });
    assert.ok((await burst(60, () => poll(secret))).every((status) => status === 200));
    assertRateLimited(await poll(secret), 60);
    assert.equal((await poll(newPollSecret())).statusCode, 200, "another secret");
  });

  test("health is never limited", async () => {
    const statuses = await burst(300, () => built.app.inject({ method: "GET", url: "/health" }));
    assert.ok(statuses.every((status) => status === 200));
  });

  test("logs: ipTag instead of addresses; no query strings, bodies or secrets", async () => {
    const { app, logs } = built;
    for (let i = 0; i < 61; i++) {
      await app.inject({
        method: "POST",
        url: "/auth/login?token=query-secret",
        remoteAddress: "192.0.2.77",
        payload: { login: "maxim", password: "hunter2-password" },
      });
    }
    const exceeded = logs.find((line) => line.msg === "rate limit exceeded" && line.route === "/auth/login");
    assert.ok(exceeded, "the exceeded limit is logged");
    assert.match(String(exceeded.ipTag), /^[0-9a-f]{12}$/);
    assert.equal(exceeded.limit, "ip");
    const text = logs.map((line) => JSON.stringify(line)).join("\n");
    for (const forbidden of ["192.0.2.77", "203.0.113.9", "2001:db8", "query-secret", "hunter2", "Bearer ey"]) {
      assert.doesNotMatch(text, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), forbidden);
    }
    const line = logs.find((entry) => entry.msg === "request" && entry.route === "/auth/login");
    assert.ok(line);
    assert.deepEqual(
      Object.keys(line)
        .filter((key) => !["level", "time", "pid", "hostname"].includes(key))
        .sort(),
      ["method", "msg", "reqId", "responseTimeMs", "route", "statusCode"],
    );
  });
});

describe(`client address and TRUST_PROXY (${TEST_DIALECT})`, () => {
  test("X-Forwarded-For and -Proto are ignored unless the peer is a trusted proxy", async () => {
    const plain = await buildApp();
    const proxied = await buildApp({ trustProxy: ["127.0.0.1/32"] });
    try {
      const headers = { "x-forwarded-for": "198.51.100.23", "x-forwarded-proto": "https" };
      const direct = await plain.app.inject({ method: "GET", url: "/test/ip", remoteAddress: "127.0.0.1", headers });
      assert.deepEqual(direct.json(), { ip: "127.0.0.1", net: "127.0.0.1", secure: false });
      const viaProxy = await proxied.app.inject({
        method: "GET",
        url: "/test/ip",
        remoteAddress: "127.0.0.1",
        headers,
      });
      assert.deepEqual(viaProxy.json(), { ip: "198.51.100.23", net: "198.51.100.23", secure: true });
      const untrustedPeer = await proxied.app.inject({
        method: "GET",
        url: "/test/ip",
        remoteAddress: "203.0.113.5",
        headers,
      });
      assert.deepEqual(untrustedPeer.json(), { ip: "203.0.113.5", net: "203.0.113.5", secure: false });
    } finally {
      await plain.app.close();
      await proxied.app.close();
    }
  });

  test("RATE_LIMIT_ENABLED=false installs no limits", async () => {
    const { app } = await buildApp({ enabled: false });
    try {
      const statuses = await burst(70, () =>
        app.inject({ method: "POST", url: "/auth/login", payload: { login: "a", password: "b" } }),
      );
      assert.ok(statuses.every((status) => status === 200));
    } finally {
      await app.close();
    }
  });
});
