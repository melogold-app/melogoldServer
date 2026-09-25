/**
 * Per-route HTTP policy, in one table instead of scattered route options:
 *
 * - **auth** (API §3 "Auth" column): `public`, `refresh` (token in the body), `pollSecret` (secret in the body) or
 *   `bearer`. Routes are **closed by default** (API §1.2): anything not listed here is `bearer`.
 * - **body limit** (API §1.9): `/sync` 4 MiB, `/sync/merge-plan` 1 MiB, `/playback/state` 128 KiB, `/auth/**`
 *   16 KiB, `/lyrics/{videoId}` 1 MiB, everything else 64 KiB.
 * - **rate limits** (API §1.10) with their keys; a Bearer route without its own row gets `120/min user`.
 * - **`X-Sync-Protocol`** is required on `/sync`, `/sync/summary`, `/sync/merge-plan`, `/playback/state` (API §1.2).
 * - **storage**: `503 storage_full` while the disk is low, on registration, `PUT /playback/state` and `/sync` with
 *   ops (DESIGN §3.10).
 *
 * {@link registerRoutePolicy} resolves the policy of every route when it is added (an `onRoute` hook, so it must be
 * registered before the routes) and stores it in `routeOptions.config.policy`, where the guard, the rate limits and
 * the other hooks read it. A route not in the table may set `config.auth` / `config.rateLimits` itself (tests,
 * `/docs` assets); a route in the table may not contradict it.
 */
import type { FastifyInstance, RouteOptions } from "fastify";
import { HOUR_MS, MINUTE_MS } from "../lib/clock.ts";

export type RouteAuth = "public" | "bearer" | "refresh" | "pollSecret";

/**
 * Rate-limit keys (API §1.10): `ip` (IPv4 whole, IPv6 /56), `user` (verified `sub`), `device` (verified `did`), `rt`
 * (`did` of an authentic refresh token, else `ip`), `ps` (`sha256(pollSecret)`, else `ip`).
 */
export type RateLimitKey = "ip" | "user" | "device" | "rt" | "ps";

export type RateLimitRule = Readonly<{ key: RateLimitKey; max: number; windowMs: number }>;

/** `always`: every request; `with_ops`: `POST /sync` whose body has a non-empty `ops` array. */
export type StorageCheck = "always" | "with_ops";

export type RoutePolicy = Readonly<{
  auth: RouteAuth;
  bodyLimit: number;
  rateLimits: readonly RateLimitRule[];
  syncProtocol: boolean;
  storage: StorageCheck | null;
}>;

declare module "fastify" {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- module augmentation needs an interface
  interface FastifyContextConfig {
    /** Only for routes outside the policy table; must agree with the table otherwise. */
    auth?: RouteAuth;
    /** Only for routes outside the policy table; must agree with the table otherwise. */
    rateLimits?: readonly RateLimitRule[];
    /** Resolved by `registerRoutePolicy`; never set by hand. */
    policy?: RoutePolicy;
  }
}

export const KIB = 1024;
export const MIB = 1024 * KIB;

/** API §1.9. */
export const BODY_LIMITS = Object.freeze({
  sync: 4 * MIB,
  mergePlan: 1 * MIB,
  playback: 128 * KIB,
  auth: 16 * KIB,
  lyrics: 1 * MIB,
  default: 64 * KIB,
});

const ip = (max: number, windowMs: number): RateLimitRule => ({ key: "ip", max, windowMs });
const user = (max: number, windowMs: number): RateLimitRule => ({ key: "user", max, windowMs });
const device = (max: number, windowMs: number): RateLimitRule => ({ key: "device", max, windowMs });
const rt = (max: number, windowMs: number): RateLimitRule => ({ key: "rt", max, windowMs });
const ps = (max: number, windowMs: number): RateLimitRule => ({ key: "ps", max, windowMs });

/** API §1.10 "Bearer по умолчанию". */
export const DEFAULT_BEARER_RATE_LIMITS: readonly RateLimitRule[] = Object.freeze([user(120, MINUTE_MS)]);

type TableRow = Readonly<{
  auth?: RouteAuth;
  rateLimits?: readonly RateLimitRule[];
  syncProtocol?: true;
  storage?: StorageCheck;
}>;

/**
 * Every route of API §3 (Fastify path syntax; parameter names do not matter for matching). Rows without `auth` are
 * Bearer; rows without `rateLimits` get the Bearer default.
 */
export const ROUTE_TABLE: Readonly<Record<string, TableRow>> = Object.freeze({
  "GET /": { auth: "public", rateLimits: [ip(60, MINUTE_MS)] },
  "GET /health": { auth: "public", rateLimits: [] },
  "GET /health/live": { auth: "public", rateLimits: [] },
  "GET /openapi.json": { auth: "public", rateLimits: [] },
  "GET /server/info": { auth: "public", rateLimits: [ip(120, MINUTE_MS)] },
  "GET /docs": { auth: "public", rateLimits: [] },

  "GET /auth/register/challenge": { auth: "public", rateLimits: [ip(30, MINUTE_MS)] },
  "POST /auth/register": { auth: "public", rateLimits: [ip(30, HOUR_MS)], storage: "always" },
  "POST /auth/login": { auth: "public", rateLimits: [ip(60, 10 * MINUTE_MS)] },
  "POST /auth/refresh": { auth: "refresh", rateLimits: [rt(30, MINUTE_MS)] },
  "POST /auth/logout": { auth: "refresh", rateLimits: [rt(30, MINUTE_MS)] },
  "POST /auth/recover": { auth: "public", rateLimits: [ip(20, HOUR_MS)] },
  "POST /auth/link/requests": { auth: "public", rateLimits: [ip(30, 10 * MINUTE_MS)] },
  "POST /auth/link/claim": { auth: "public", rateLimits: [ip(30, 10 * MINUTE_MS)] },
  "POST /auth/link/poll": { auth: "pollSecret", rateLimits: [ps(60, MINUTE_MS), ip(600, MINUTE_MS)] },
  "POST /auth/link/cancel": { auth: "pollSecret", rateLimits: [ps(60, MINUTE_MS), ip(600, MINUTE_MS)] },

  "GET /auth/me": {},
  "GET /auth/me/events": { rateLimits: [user(30, MINUTE_MS)] },
  "GET /auth/me/devices": {},
  "PATCH /auth/me/devices/:deviceId": {},
  "POST /auth/me/devices/:deviceId/revoke": {},
  "POST /auth/me/devices/revoke-others": {},
  "POST /auth/me/password": { rateLimits: [user(5, HOUR_MS)] },
  "POST /auth/me/recovery-code": { rateLimits: [user(5, HOUR_MS)] },
  "POST /auth/me/recovery-code/confirm": {},
  "POST /auth/me/delete": { rateLimits: [user(5, HOUR_MS)] },
  "GET /auth/me/export": { rateLimits: [user(3, HOUR_MS)] },
  "POST /auth/me/links": { rateLimits: [user(10, 10 * MINUTE_MS)] },
  "POST /auth/me/links/resolve": { rateLimits: [user(20, 10 * MINUTE_MS)] },
  "GET /auth/me/links/:linkId": {},
  "POST /auth/me/links/:linkId/approve": {},
  "POST /auth/me/links/:linkId/deny": {},
  "POST /auth/me/links/:linkId/cancel": {},

  "GET /sync/summary": { rateLimits: [user(10, MINUTE_MS)], syncProtocol: true },
  "POST /sync/merge-plan": { rateLimits: [user(10, MINUTE_MS)], syncProtocol: true },
  "POST /sync": { rateLimits: [user(120, MINUTE_MS)], syncProtocol: true, storage: "with_ops" },
  "GET /playback/state": { rateLimits: [device(60, MINUTE_MS)], syncProtocol: true },
  "PUT /playback/state": { rateLimits: [device(30, MINUTE_MS)], syncProtocol: true, storage: "always" },
  "DELETE /playback/state": { rateLimits: [user(10, MINUTE_MS)], syncProtocol: true },

  "GET /lyrics/:videoId": {},
  "PUT /lyrics/:videoId": { rateLimits: [user(60, MINUTE_MS)], storage: "always" },
  "DELETE /lyrics/:videoId": { rateLimits: [user(60, MINUTE_MS)] },
  "POST /auth/me/lyrics/changes": {},
});

/** `/auth/me/devices/:deviceId` (or `{deviceId}`) → `/auth/me/devices/:`; `HEAD` is looked up as `GET`. */
export function routeKey(method: string, url: string): string {
  const verb = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  return `${verb} ${url.replace(/:[^/]+/g, ":").replace(/\{[^/]+\}/g, ":")}`;
}

const TABLE_BY_KEY: ReadonlyMap<string, TableRow> = new Map(
  Object.entries(ROUTE_TABLE).map(([key, row]) => {
    const space = key.indexOf(" ");
    return [routeKey(key.slice(0, space), key.slice(space + 1)), row];
  }),
);

/** API §1.9 limits by path. */
export function bodyLimitFor(url: string): number {
  if (url === "/sync") return BODY_LIMITS.sync;
  if (url === "/sync/merge-plan") return BODY_LIMITS.mergePlan;
  if (url === "/playback/state") return BODY_LIMITS.playback;
  if (url === "/auth" || url.startsWith("/auth/")) return BODY_LIMITS.auth;
  if (url.startsWith("/lyrics/")) return BODY_LIMITS.lyrics;
  return BODY_LIMITS.default;
}

export class RoutePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutePolicyError";
  }
}

function sameRules(a: readonly RateLimitRule[], b: readonly RateLimitRule[]): boolean {
  return (
    a.length === b.length &&
    a.every((rule, index) => {
      const other = b[index];
      return rule.key === other?.key && rule.max === other.max && rule.windowMs === other.windowMs;
    })
  );
}

function checkRules(rules: readonly RateLimitRule[], where: string): void {
  for (const rule of rules) {
    if (!Number.isInteger(rule.max) || rule.max < 1 || !Number.isInteger(rule.windowMs) || rule.windowMs < 1) {
      throw new RoutePolicyError(`${where}: invalid rate limit ${JSON.stringify(rule)}`);
    }
  }
}

/**
 * The policy of a route. `OPTIONS` (CORS preflight) and `/docs/**` (API docs UI assets) are public and unlimited.
 * @param explicit `config.auth` / `config.rateLimits` of the route, if any.
 * @throws RoutePolicyError when the explicit values contradict the table.
 */
export function resolveRoutePolicy(
  method: string,
  url: string,
  explicit: Readonly<{ auth?: RouteAuth; rateLimits?: readonly RateLimitRule[] }> = {},
): RoutePolicy {
  const key = routeKey(method, url);
  const bodyLimit = bodyLimitFor(url);
  if (method.toUpperCase() === "OPTIONS" || url === "/docs" || url.startsWith("/docs/")) {
    return Object.freeze({ auth: "public", bodyLimit, rateLimits: [], syncProtocol: false, storage: null });
  }
  const row = TABLE_BY_KEY.get(key);
  if (row) {
    const auth = row.auth ?? "bearer";
    const rateLimits = row.rateLimits ?? (auth === "bearer" ? DEFAULT_BEARER_RATE_LIMITS : []);
    if (explicit.auth !== undefined && explicit.auth !== auth) {
      throw new RoutePolicyError(`${key}: config.auth "${explicit.auth}" contradicts API §3 ("${auth}")`);
    }
    if (explicit.rateLimits !== undefined && !sameRules(explicit.rateLimits, rateLimits)) {
      throw new RoutePolicyError(`${key}: config.rateLimits contradicts API §1.10`);
    }
    return Object.freeze({
      auth,
      bodyLimit,
      rateLimits: Object.freeze([...rateLimits]),
      syncProtocol: row.syncProtocol === true,
      storage: row.storage ?? null,
    });
  }
  const auth = explicit.auth ?? "bearer";
  const rateLimits = explicit.rateLimits ?? (auth === "bearer" ? DEFAULT_BEARER_RATE_LIMITS : []);
  checkRules(rateLimits, key);
  return Object.freeze({
    auth,
    bodyLimit,
    rateLimits: Object.freeze([...rateLimits]),
    syncProtocol: false,
    storage: null,
  });
}

function methods(route: RouteOptions): string[] {
  return Array.isArray(route.method) ? [...route.method] : [route.method];
}

/**
 * Resolves the policy of every route added after this call (`onRoute`): stores it in `config.policy` and applies the
 * body limit unless the route set its own `bodyLimit`.
 */
export function registerRoutePolicy(app: FastifyInstance): void {
  app.addHook("onRoute", (route) => {
    const list = methods(route);
    const policies = list.map((method) =>
      resolveRoutePolicy(method, route.url, { auth: route.config?.auth, rateLimits: route.config?.rateLimits }),
    );
    const [policy] = policies;
    if (!policy) return;
    if (policies.some((other) => other.auth !== policy.auth || !sameRules(other.rateLimits, policy.rateLimits))) {
      throw new RoutePolicyError(`${list.join(",")} ${route.url}: one route with several methods needs one policy`);
    }
    route.config = { ...route.config, policy };
    route.bodyLimit ??= policy.bodyLimit;
  });
}
