/**
 * The route policy table equals the contract: every route of API §3 with its auth and `X-Sync-Protocol`, the limits
 * of API §1.10 and the body limits of API §1.9. The tables are read from `docs/API.md`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { HOUR_MS, MINUTE_MS } from "../lib/clock.ts";
import {
  BODY_LIMITS,
  DEFAULT_BEARER_RATE_LIMITS,
  ROUTE_TABLE,
  RoutePolicyError,
  bodyLimitFor,
  resolveRoutePolicy,
  routeKey,
} from "./route-policy.ts";
import type { RateLimitRule, RouteAuth } from "./route-policy.ts";

const API = readFileSync(new URL("../../docs/API.md", import.meta.url), "utf8");

function section(start: string, end: string): string {
  const from = API.indexOf(start);
  const to = API.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `section ${start} not found`);
  return API.slice(from, to);
}

function rows(text: string): string[][] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("|") && !/^\|\s*-/.test(line))
    .map((line) =>
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    )
    .slice(1);
}

const toFastifyPath = (path: string) => path.replace(/\{(\w+)\}/g, ":$1");

type ApiRoute = { method: string; path: string; auth: RouteAuth; xsp: boolean };

function apiRoutes(): ApiRoute[] {
  return rows(section("## 3. Эндпоинты", "## 4.")).map(([, method = "", pathCell = "", , authCell = ""]) => {
    const path = toFastifyPath(/`([^`]+)`/.exec(pathCell)?.[1] ?? "");
    const auth: RouteAuth = authCell.startsWith("Bearer")
      ? "bearer"
      : authCell === "refresh"
        ? "refresh"
        : authCell === "pollSecret"
          ? "pollSecret"
          : "public";
    return { method, path, auth, xsp: authCell.includes("XSP") };
  });
}

describe("route policy vs API §3", () => {
  const routes = apiRoutes();

  test("the table was parsed (38 numbered routes and /docs)", () => {
    assert.equal(routes.length, 39);
  });

  test("every API route is in the policy table with its auth and X-Sync-Protocol", () => {
    for (const route of routes) {
      const key = `${route.method} ${route.path}`;
      assert.ok(Object.hasOwn(ROUTE_TABLE, key), `${key} missing from ROUTE_TABLE`);
      const policy = resolveRoutePolicy(route.method, route.path);
      assert.equal(policy.auth, route.auth, key);
      assert.equal(policy.syncProtocol, route.xsp, key);
    }
  });

  test("the policy table has no route the API does not have", () => {
    const api = new Set(routes.map((route) => `${route.method} ${route.path}`));
    for (const key of Object.keys(ROUTE_TABLE)) assert.ok(api.has(key), `${key} is not in API §3`);
  });

  test("closed by default: an unknown route is Bearer with the default limit", () => {
    const policy = resolveRoutePolicy("GET", "/something/new");
    assert.equal(policy.auth, "bearer");
    assert.deepEqual(policy.rateLimits, DEFAULT_BEARER_RATE_LIMITS);
  });
});

function parseLimits(cell: string): RateLimitRule[] {
  const rules: RateLimitRule[] = [];
  for (const match of cell.matchAll(/(\d+)(?: открытий)?\/(?:(\d+) )?(мин|ч) (ip|user|device|rt|ps)\b/g)) {
    const [, max = "", count = "1", unit = "", key = ""] = match;
    rules.push({
      key: key as RateLimitRule["key"],
      max: Number(max),
      windowMs: Number(count) * (unit === "ч" ? HOUR_MS : MINUTE_MS),
    });
  }
  return rules;
}

/** Route cells of API §1.10: "`GET /`", "`POST /auth/link/poll`, `/auth/link/cancel`", "`me/password`, …". */
function parseRoutes(cell: string): string[] {
  const keys: string[] = [];
  let method = "";
  for (const [, token = ""] of cell.matchAll(/`([^`]+)`/g)) {
    const full = /^(GET|POST|PUT|PATCH|DELETE) (\/\S*)$/.exec(token);
    if (full) {
      method = full[1] ?? "";
      keys.push(`${method} ${full[2] ?? ""}`);
    } else if (token.startsWith("me/")) {
      keys.push(`POST /auth/${token}`);
    } else if (token.startsWith("/")) {
      keys.push(`${method || "GET"} ${token}`);
    }
  }
  return keys;
}

describe("rate limits vs API §1.10", () => {
  const table = rows(section("| Маршрут | Лимит |", "## 2. Ошибки"));

  test("every row of the table matches the policy", () => {
    let checked = 0;
    for (const [routeCell = "", limitCell = ""] of table) {
      if (routeCell.startsWith("Bearer")) {
        assert.deepEqual(parseLimits(limitCell), DEFAULT_BEARER_RATE_LIMITS);
        continue;
      }
      const expected = limitCell.includes("без лимита") ? [] : parseLimits(limitCell);
      for (const key of parseRoutes(routeCell)) {
        if (key.endsWith("*")) {
          for (const path of ["/health", "/health/live"]) {
            assert.deepEqual(resolveRoutePolicy("GET", path).rateLimits, [], path);
          }
          continue;
        }
        const [method = "", path = ""] = key.split(" ");
        const actual = [...resolveRoutePolicy(method, path).rateLimits].sort((a, b) => a.key.localeCompare(b.key));
        const want = [...expected].sort((a, b) => a.key.localeCompare(b.key));
        assert.deepEqual(actual, want, key);
        checked += 1;
      }
    }
    assert.ok(checked >= 25, `only ${checked} routes checked`);
  });

  test("Bearer routes without a row get 120/min user", () => {
    assert.deepEqual(resolveRoutePolicy("GET", "/auth/me").rateLimits, [
      { key: "user", max: 120, windowMs: MINUTE_MS },
    ]);
    assert.deepEqual(resolveRoutePolicy("PATCH", "/auth/me/devices/:id").rateLimits, DEFAULT_BEARER_RATE_LIMITS);
  });
});

describe("body limits (API §1.9)", () => {
  test("by path", () => {
    assert.equal(bodyLimitFor("/sync"), 4 * 1024 * 1024);
    assert.equal(bodyLimitFor("/sync/merge-plan"), 1024 * 1024);
    assert.equal(bodyLimitFor("/playback/state"), 128 * 1024);
    assert.equal(bodyLimitFor("/auth/register"), 16 * 1024);
    assert.equal(bodyLimitFor("/auth/me/devices/:deviceId"), 16 * 1024);
    assert.equal(bodyLimitFor("/sync/summary"), 64 * 1024);
    assert.equal(bodyLimitFor("/authx"), 64 * 1024);
    assert.equal(BODY_LIMITS.default, 65_536);
    assert.equal(resolveRoutePolicy("POST", "/sync").bodyLimit, BODY_LIMITS.sync);
  });
});

describe("resolveRoutePolicy", () => {
  test("HEAD follows GET, parameter names do not matter", () => {
    assert.equal(routeKey("HEAD", "/auth/me/links/:id"), routeKey("GET", "/auth/me/links/:linkId"));
    assert.equal(resolveRoutePolicy("HEAD", "/server/info").auth, "public");
  });

  test("OPTIONS and /docs assets are public and unlimited", () => {
    assert.equal(resolveRoutePolicy("OPTIONS", "/sync").auth, "public");
    assert.deepEqual(resolveRoutePolicy("GET", "/docs/static/index.html").rateLimits, []);
  });

  test("storage checks (DESIGN §3.10)", () => {
    assert.equal(resolveRoutePolicy("POST", "/auth/register").storage, "always");
    assert.equal(resolveRoutePolicy("PUT", "/playback/state").storage, "always");
    assert.equal(resolveRoutePolicy("POST", "/sync").storage, "with_ops");
    assert.equal(resolveRoutePolicy("POST", "/auth/login").storage, null);
  });

  test("explicit config may not contradict the table", () => {
    assert.throws(() => resolveRoutePolicy("GET", "/auth/me", { auth: "public" }), RoutePolicyError);
    assert.throws(
      () => resolveRoutePolicy("POST", "/sync", { rateLimits: [{ key: "ip", max: 1, windowMs: 1 }] }),
      RoutePolicyError,
    );
    assert.equal(resolveRoutePolicy("GET", "/server/info", { auth: "public" }).auth, "public");
  });

  test("routes outside the table may declare their own policy", () => {
    const policy = resolveRoutePolicy("GET", "/test/public", {
      auth: "public",
      rateLimits: [{ key: "ip", max: 2, windowMs: 1000 }],
    });
    assert.equal(policy.auth, "public");
    assert.equal(policy.rateLimits[0]?.max, 2);
    assert.throws(
      () => resolveRoutePolicy("GET", "/test/x", { rateLimits: [{ key: "ip", max: 0, windowMs: 1000 }] }),
      RoutePolicyError,
    );
  });
});
