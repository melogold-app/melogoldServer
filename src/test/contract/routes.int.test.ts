/**
 * The routes of the application against API §3 (DESIGN §10 contract tests, PLAN M0 acceptance), on both dialects:
 * - every route of API §3 exists (38 and `/docs` when enabled), and no other;
 * - closed by default: every Bearer route answers `401 unauthorized` without a token, public routes never do;
 * - every M0 stub answers `501 not_implemented` after authentication and validation (a valid request), and `400` for
 *   an invalid body, which proves validation runs first;
 * - every error is the 4-key envelope with a registered code; an unknown route is `404 not_found`; so is a path
 *   Fastify rejects before routing;
 * - M12 on the real contract routes: Int32 overflow of `PUT /playback/state`, sanitization of `POST /auth/login`;
 * - `DELETE` has no body whatever its `Content-Type`;
 * - every observed error status is documented for its operation (except 501, which is never documented).
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { FastifyReply, FastifyRequest, InjectOptions, RouteOptions } from "fastify";
import type { z } from "zod";
import {
  ApproveLinkRequest,
  CancelLinkRequestRequest,
  ChangePasswordRequest,
  ClaimLinkRequest,
  ConfirmRecoveryCodeRequest,
  CreateLinkInviteRequest,
  CreateLinkRequestRequest,
  DeleteAccountRequest,
  EmptyRequest,
  LoginRequest,
  LogoutRequest,
  MergePlanRequest,
  PlaybackPut,
  PollLinkRequest,
  RecoverRequest,
  RefreshRequest,
  RegisterRequest,
  RenameDeviceRequest,
  ResolveLinkRequest,
  RevokeDeviceRequest,
  RevokeOthersRequest,
  RotateRecoveryCodeRequest,
  SyncRequestEnvelope,
} from "../../contract/index.ts";
import { bearer, createAccount } from "../factories.ts";
import type { TestAccount } from "../factories.ts";
import { assertError, createTestApp, json } from "../test-app.ts";
import type { TestApp } from "../test-app.ts";
import { apiRoutes } from "./api-table.ts";
import type { ApiRoute } from "./api-table.ts";

const HWID = "3fa9c1d2e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1";
const DEVICE = { hwid: HWID, name: "Google Pixel 8", platform: "android" };
const POLL_SECRET = `mgps_${"Zr8aB3cD4eF5gH6iJ7kL8mN9oP0qR1sT2uV3wX4yZ5a".slice(0, 43)}`;
const SOME_ID = "5b0e7c1a-2d3e-4f5a-8b6c-7d8e9f0a1b2c";

/** A valid body for every route with one, checked against its schema below. */
const VALID_BODIES: Readonly<Record<string, readonly [z.ZodType, unknown]>> = {
  "POST /auth/register": [RegisterRequest, { login: "Maxim", password: "две собаки и кот", device: DEVICE }],
  "POST /auth/login": [LoginRequest, { login: "maxim", password: "две собаки и кот", device: DEVICE }],
  "POST /auth/refresh": [
    RefreshRequest,
    { refreshToken: "mgrt1.eyJ0eXAiOiJyZWZyZXNoIn0.Xk3q", device: { hwid: HWID } },
  ],
  "POST /auth/logout": [LogoutRequest, { refreshToken: "mgrt1.eyJ0eXAiOiJyZWZyZXNoIn0.Xk3q" }],
  "POST /auth/recover": [
    RecoverRequest,
    { login: "maxim", recoveryCode: "7kq2 mx9d 4tnp b8rw 3hzf", newPassword: "новый длинный пароль", device: DEVICE },
  ],
  "POST /auth/link/requests": [CreateLinkRequestRequest, { device: DEVICE }],
  "POST /auth/link/claim": [ClaimLinkRequest, { userCode: "K7QX-M2PD", device: DEVICE }],
  "POST /auth/link/poll": [PollLinkRequest, { pollSecret: POLL_SECRET, knownStatus: "pending" }],
  "POST /auth/link/cancel": [CancelLinkRequestRequest, { pollSecret: POLL_SECRET }],
  "PATCH /auth/me/devices/:deviceId": [RenameDeviceRequest, { name: "Рабочий ноутбук" }],
  "POST /auth/me/devices/:deviceId/revoke": [RevokeDeviceRequest, {}],
  "POST /auth/me/devices/revoke-others": [RevokeOthersRequest, {}],
  "POST /auth/me/password": [ChangePasswordRequest, { newPassword: "новый длинный пароль" }],
  "POST /auth/me/recovery-code": [RotateRecoveryCodeRequest, { password: "две собаки и кот" }],
  "POST /auth/me/recovery-code/confirm": [
    ConfirmRecoveryCodeRequest,
    { recoveryCodeCreatedAt: "2026-09-24T08:00:00.000Z" },
  ],
  "POST /auth/me/delete": [DeleteAccountRequest, { password: "две собаки и кот" }],
  "POST /auth/me/links": [CreateLinkInviteRequest, {}],
  "POST /auth/me/links/resolve": [ResolveLinkRequest, { userCode: "k7qx m2pd" }],
  "POST /auth/me/links/:linkId/approve": [ApproveLinkRequest, { verifyCode: "47" }],
  "POST /auth/me/links/:linkId/deny": [EmptyRequest, {}],
  "POST /auth/me/links/:linkId/cancel": [EmptyRequest, {}],
  "POST /sync/merge-plan": [MergePlanRequest, { playlists: [] }],
  "POST /sync": [SyncRequestEnvelope, { cursor: "" }],
  "PUT /playback/state": [
    PlaybackPut,
    {
      sessionId: "e2a1b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5c",
      queueVersion: 0,
      at: "2026-09-23T10:00:00.000Z",
      index: 0,
      positionMs: 0,
      playing: false,
    },
  ],
};

/** Routes implemented in M0 (the server module) or by a finished M1 task; every other route is a stub. */
const IMPLEMENTED = new Set([
  "GET /",
  "GET /health",
  "GET /health/live",
  "GET /openapi.json",
  "GET /server/info",
  "GET /docs",
  // PLAN T1.3 (account): password, recovery code, recover, deletion, export.
  "POST /auth/recover",
  "POST /auth/me/password",
  "POST /auth/me/recovery-code",
  "POST /auth/me/recovery-code/confirm",
  "POST /auth/me/delete",
  "GET /auth/me/export",
]);

let t: TestApp;
let account: TestAccount;
const registered: RouteOptions[] = [];
const ROUTES: ApiRoute[] = apiRoutes();
/** Bodies the real `POST /auth/login` handler received (after sanitization and validation). */
const loginBodies: unknown[] = [];

/** Wraps the handler of the real `POST /auth/login` to record what it receives, then runs it (the M0 stub). */
function observeLogin(route: RouteOptions): void {
  if (route.method !== "POST" || route.url !== "/auth/login") return;
  const original = route.handler;
  route.handler = function (this: unknown, request: FastifyRequest, reply: FastifyReply) {
    loginBodies.push(request.body);
    return original.call(this as never, request, reply);
  };
}

before(async () => {
  t = await createTestApp({
    env: { OPENAPI_DOCS_UI: "true" },
    onRoute: (route) => {
      registered.push(route);
      observeLogin(route);
    },
  });
  account = await createAccount(t.ctx);
});

after(async () => {
  await t.close();
});

const key = (route: ApiRoute) => `${route.method} ${route.fastifyPath}`;

function request(route: ApiRoute, options: { token?: string; body?: unknown } = {}): InjectOptions {
  const url = route.path.replace(/\{\w+\}/g, SOME_ID);
  const headers: Record<string, string> = {};
  if (options.token !== undefined) Object.assign(headers, bearer(options.token));
  if (route.syncProtocol) headers["x-sync-protocol"] = "1";
  const hasBody = ["POST", "PUT", "PATCH"].includes(route.method);
  if (hasBody) headers["content-type"] = "application/json";
  return {
    method: route.method as InjectOptions["method"],
    url,
    headers,
    ...(hasBody ? { payload: JSON.stringify(options.body ?? VALID_BODIES[key(route)]?.[1] ?? {}) } : {}),
  };
}

/** The statuses `operation()` documented for a route. */
function documentedStatuses(route: ApiRoute): string[] {
  const options = registered.find((item) => item.method === route.method && item.url === route.fastifyPath);
  return Object.keys(options?.schema?.response ?? {});
}

describe("routes of API §3", () => {
  test("the valid bodies of this test match their schemas", () => {
    for (const [name, [schema, body]] of Object.entries(VALID_BODIES)) {
      const result = schema.safeParse(body);
      assert.ok(result.success, `${name}: ${JSON.stringify(result.error?.issues)}`);
    }
  });

  test("every route of API §3 exists, and no other", () => {
    assert.equal(ROUTES.length, 39);
    const actual = registered
      .flatMap((route) =>
        (Array.isArray(route.method) ? route.method : [route.method]).map((method) => `${method} ${route.url}`),
      )
      .filter((name) => !name.startsWith("HEAD ") && !name.startsWith("OPTIONS "));
    assert.deepEqual(actual.sort(), ROUTES.map(key).sort());
    for (const route of ROUTES) {
      assert.ok(t.app.hasRoute({ method: route.method, url: route.fastifyPath }), key(route));
    }
  });

  test("closed by default: every Bearer route answers 401 unauthorized without a token", async () => {
    for (const route of ROUTES.filter((item) => item.auth === "bearer")) {
      const response = await t.app.inject(request(route));
      assertError(response, 401, "unauthorized");
      assert.ok(documentedStatuses(route).includes("401"), `${key(route)}: 401 documented`);
    }
  });

  test("public routes never ask for a token", async () => {
    for (const route of ROUTES.filter((item) => item.auth !== "bearer")) {
      const response = await t.app.inject(request(route));
      // A public, now-implemented route may still answer its own business 401 (e.g. POST /auth/recover with an
      // unknown login → 401 invalid_recovery_code, DESIGN §4.9 enumeration protection): only the guard's own
      // "unauthorized" for a missing/invalid token would mean the route is not actually public.
      const code = response.statusCode === 401 ? json(response).code : null;
      assert.notEqual(code, "unauthorized", `${key(route)}: ${response.body}`);
    }
  });

  test("every stub answers 501 not_implemented to a valid, authenticated request", async () => {
    const stubs = ROUTES.filter((route) => !IMPLEMENTED.has(key(route)));
    assert.equal(stubs.length, 27);
    for (const route of stubs) {
      const token = route.auth === "bearer" ? account.session.tokens.accessToken : undefined;
      const response = await t.app.inject(request(route, token === undefined ? {} : { token }));
      assertError(response, 501, "not_implemented");
    }
  });

  test("validation runs before the stub: an invalid body is 400 invalid_request, a wrong type 415", async () => {
    for (const route of ROUTES.filter((item) => VALID_BODIES[key(item)] !== undefined)) {
      const token = route.auth === "bearer" ? account.session.tokens.accessToken : undefined;
      const invalid = await t.app.inject(request(route, { ...(token === undefined ? {} : { token }), body: [] }));
      const body = assertError(invalid, 400, "invalid_request");
      assert.ok(Array.isArray(body.issues), key(route));
      assert.ok(documentedStatuses(route).includes("400"), `${key(route)}: 400 documented`);

      const options = request(route, token === undefined ? {} : { token });
      const wrongType = await t.app.inject({
        ...options,
        headers: { ...options.headers, "content-type": "text/plain" },
      });
      assertError(wrongType, 415, "unsupported_media_type");
      assert.ok(documentedStatuses(route).includes("415"), `${key(route)}: 415 documented`);
    }
  });

  test("a malformed path id is 400 invalid_request", async () => {
    const response = await t.app.inject({
      method: "GET",
      url: "/auth/me/links/NOT-A-UUID",
      headers: bearer(account.session.tokens.accessToken),
    });
    assertError(response, 400, "invalid_request");
  });

  test("a path Fastify rejects before routing is 400 invalid_request with X-Request-Id and no-store", async () => {
    const cases = [
      ["/%", "invalid_format"],
      ["/auth/me/links/%zz", "invalid_format"],
      [`/auth/me/links/${"a".repeat(101)}`, "too_big"],
    ] as const;
    for (const [url, code] of cases) {
      const response = await t.app.inject({ method: "GET", url, headers: bearer(account.session.tokens.accessToken) });
      const body = assertError(response, 400, "invalid_request");
      assert.deepEqual(body.issues, [{ path: "url", code }], url);
      assert.equal(response.headers["cache-control"], "no-store");
      assert.match(String(response.headers["x-request-id"]), /^[0-9a-f-]{36}$/);
    }
  });

  test("M12: Int32 on the real PUT /playback/state: 2^31−1 passes validation (501), 2^31 is 400 at queueVersion", async () => {
    const route = ROUTES.find((item) => key(item) === "PUT /playback/state");
    assert.ok(route);
    const valid = VALID_BODIES["PUT /playback/state"]?.[1] as Record<string, unknown>;
    const token = account.session.tokens.accessToken;
    const max = await t.app.inject(request(route, { token, body: { ...valid, queueVersion: 2_147_483_647 } }));
    assertError(max, 501, "not_implemented");
    const over = await t.app.inject(request(route, { token, body: { ...valid, queueVersion: 2_147_483_648 } }));
    const body = assertError(over, 400, "invalid_request");
    assert.deepEqual(body.issues, [{ path: "queueVersion", code: "too_big" }]);
  });

  test("M12: the real POST /auth/login gets NUL removed and lone surrogates replaced before validation", async () => {
    const route = ROUTES.find((item) => key(item) === "POST /auth/login");
    assert.ok(route);
    loginBodies.length = 0;
    const raw =
      '{"login":"ma\\u0000xim\\ud800","password":"две собаки\\u0000 и кот\\udc00",' +
      `"device":{"hwid":"${HWID}","name":"Pix\\u0000el\\udbff","platform":"android"}}`;
    const response = await t.app.inject({ ...request(route), payload: raw });
    assertError(response, 501, "not_implemented");
    assert.equal(loginBodies.length, 1);
    const seen = loginBodies[0] as { login: string; password: string; device: { name: string; hwid: string } };
    assert.equal(seen.login, "maxim\uFFFD");
    assert.equal(seen.password, "две собаки и кот\uFFFD");
    assert.equal(seen.device.name, "Pixel\uFFFD");
    assert.equal(seen.device.hwid, HWID);
    // NUL alone becomes an empty login, which the schema then refuses: sanitization runs first.
    const empty = await t.app.inject({
      ...request(route),
      payload: JSON.stringify({ login: "\u0000", password: "x", device: DEVICE }),
    });
    const refused = assertError(empty, 400, "invalid_request");
    assert.deepEqual(refused.issues, [{ path: "login", code: "too_small" }]);
    assert.equal(loginBodies.length, 1);
  });

  test("DELETE has no body: a JSON (or any) Content-Type with an empty body is not a JSON error", async () => {
    const headers = { ...bearer(account.session.tokens.accessToken), "x-sync-protocol": "1" };
    const variants = [
      { headers: { ...headers, "content-type": "application/json" } },
      { headers: { ...headers, "content-type": "application/json", "content-length": "0" }, payload: "" },
      { headers: { ...headers, "content-type": "application/json" }, payload: "{" },
      { headers: { ...headers, "content-type": "text/plain" }, payload: "x" },
    ];
    for (const variant of variants) {
      const response = await t.app.inject({ method: "DELETE", url: "/playback/state", ...variant });
      assertError(response, 501, "not_implemented");
    }
  });

  test("X-Sync-Protocol is checked on its routes: missing → 400, unsupported → 409", async () => {
    for (const route of ROUTES.filter((item) => item.syncProtocol)) {
      const options = request(route, { token: account.session.tokens.accessToken });
      const headers = { ...(options.headers as Record<string, string>) };
      delete headers["x-sync-protocol"];
      assertError(await t.app.inject({ ...options, headers }), 400, "invalid_request");
      const body = assertError(
        await t.app.inject({ ...options, headers: { ...headers, "x-sync-protocol": "2" } }),
        409,
        "protocol_unsupported",
      );
      assert.deepEqual([body.minProtocol, body.maxProtocol], [1, 1]);
    }
  });

  test("an unknown route is 404 not_found, with or without a token", async () => {
    assertError(await t.app.inject({ method: "GET", url: "/history" }), 404, "not_found");
    assertError(await t.app.inject({ method: "DELETE", url: `/auth/me/devices/${SOME_ID}` }), 404, "not_found");
    assertError(
      await t.app.inject({
        method: "POST",
        url: "/link/claim",
        headers: { "content-type": "text/plain" },
        payload: "x",
      }),
      404,
      "not_found",
    );
  });
});
