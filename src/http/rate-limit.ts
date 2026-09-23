/**
 * Rate limits (API §1.10) on top of `@fastify/rate-limit` (fixed windows in process memory, DESIGN §11: one process).
 *
 * Each route gets the rules of its policy (`route-policy.ts`); every rule is its own counter store. Keys:
 *
 * | key      | value                                                                     | checked in      |
 * | -------- | ------------------------------------------------------------------------- | --------------- |
 * | `ip`     | `request.ip` (via `TRUST_PROXY`), IPv4 whole, IPv6 /56                    | `onRequest`     |
 * | `user`   | verified `sub` (the guard ran before)                                     | `onRequest`     |
 * | `device` | verified `did`                                                            | `onRequest`     |
 * | `rt`     | `did` of a refresh token with a valid HMAC (expiry not checked), else ip  | `preValidation` |
 * | `ps`     | `sha256(pollSecret)` of a well-formed poll secret, else ip                | `preValidation` |
 *
 * Exceeding a rule answers `429 rate_limited` with `retryAfterSeconds` and `Retry-After`; the log line carries the
 * `ipTag`, never the address. With `RATE_LIMIT_ENABLED=false` nothing is installed.
 */
import fastifyRateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { sha256Hex } from "../lib/crypto.ts";
import { POLL_SECRET_PATTERN, parseRefreshToken } from "../lib/tokens.ts";
import { clientNet } from "./client-ip.ts";
import { AppError } from "./errors.ts";
import type { IpTagger } from "./logging.ts";
import type { RateLimitKey, RateLimitRule } from "./route-policy.ts";

export type RateLimitDeps = Readonly<{
  /** `RATE_LIMIT_ENABLED`. */
  enabled: boolean;
  /** HKDF subkey `melogold/refresh-token/v1`, to authenticate the `rt` key. */
  refreshKey: Uint8Array;
  ipTag: IpTagger;
  /** Keys kept per rule (LRU); an evicted key starts a new window. */
  cacheSize?: number;
}>;

export const DEFAULT_RATE_LIMIT_CACHE = 10_000;

function bodyField(request: FastifyRequest, field: string): unknown {
  const body = request.body;
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>)[field] : undefined;
}

/** The counter key of a rule for this request (namespaced, so an `ip` fallback never meets a device id). */
export function rateLimitKey(key: RateLimitKey, request: FastifyRequest, refreshKey: Uint8Array): string {
  const ipKey = `ip:${clientNet(request.ip)}`;
  switch (key) {
    case "ip":
      return ipKey;
    case "user":
      return request.auth ? `user:${request.auth.userId}` : ipKey;
    case "device":
      return request.auth ? `device:${request.auth.deviceId}` : ipKey;
    case "rt": {
      const token = bodyField(request, "refreshToken");
      const payload = typeof token === "string" ? parseRefreshToken(token, refreshKey) : null;
      return payload ? `rt:${payload.did}` : ipKey;
    }
    case "ps": {
      const secret = bodyField(request, "pollSecret");
      return typeof secret === "string" && POLL_SECRET_PATTERN.test(secret) ? `ps:${sha256Hex(secret)}` : ipKey;
    }
  }
}

/** Keys known before the body is parsed. */
const EARLY_KEYS: ReadonlySet<RateLimitKey> = new Set(["ip", "user", "device"]);

type Limiter = Readonly<{
  rule: RateLimitRule;
  check: ReturnType<FastifyInstance["createRateLimit"]>;
}>;

async function enforce(limiters: readonly Limiter[], request: FastifyRequest, ipTag: IpTagger): Promise<void> {
  for (const limiter of limiters) {
    const result = await limiter.check(request);
    if (result.isAllowed || !result.isExceeded) continue;
    request.log.warn(
      {
        route: request.routeOptions.url ?? null,
        limit: limiter.rule.key,
        max: limiter.rule.max,
        windowMs: limiter.rule.windowMs,
        ipTag: ipTag(request.ip),
      },
      "rate limit exceeded",
    );
    throw new AppError("rate_limited", { details: { retryAfterSeconds: Math.max(1, result.ttlInSeconds) } });
  }
}

/**
 * Registers `@fastify/rate-limit` (without its global hook) and adds the hooks of every route's rules when the route
 * is added. Call after `registerRoutePolicy` and before the routes.
 */
export async function registerRateLimits(app: FastifyInstance, deps: RateLimitDeps): Promise<void> {
  if (!deps.enabled) return;
  await app.register(fastifyRateLimit, { global: false });
  const cacheSize = deps.cacheSize ?? DEFAULT_RATE_LIMIT_CACHE;

  app.addHook("onRoute", (route) => {
    const rules = route.config?.policy?.rateLimits ?? [];
    if (rules.length === 0) return;
    const limiters: Limiter[] = rules.map((rule) => ({
      rule,
      check: app.createRateLimit({
        max: rule.max,
        timeWindow: rule.windowMs,
        keyGenerator: (request) => rateLimitKey(rule.key, request, deps.refreshKey),
        // `cache` is honoured by the plugin's store per limiter although CreateRateLimitOptions does not declare it.
        ...({ cache: cacheSize } as object),
      }),
    }));
    const early = limiters.filter((limiter) => EARLY_KEYS.has(limiter.rule.key));
    const late = limiters.filter((limiter) => !EARLY_KEYS.has(limiter.rule.key));
    if (early.length > 0) {
      route.onRequest = [...toArray(route.onRequest), (request) => enforce(early, request, deps.ipTag)];
    }
    if (late.length > 0) {
      route.preValidation = [...toArray(route.preValidation), (request) => enforce(late, request, deps.ipTag)];
    }
  });
}

function toArray<T>(value: T | readonly T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? [...(value as readonly T[])] : [value as T];
}
