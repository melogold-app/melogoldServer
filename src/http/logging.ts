/**
 * Logging and privacy (DESIGN §9 "Приватность и логи").
 *
 * - Fastify's request logging is off; {@link registerRequestLogging} writes one line per response: `reqId`, method,
 *   route **template**, status, time. Bodies, query strings and IP addresses are never logged.
 * - Rate-limit and similar records carry `ipTag = HMAC-SHA256(dailyKey, ip)[:12]` ({@link createIpTagger}); the key
 *   lives only in memory and changes at 00:00 UTC (m16).
 * - Every log object is masked ({@link maskSecrets}, m13): `authorization`, `cookie`, `*password*`,
 *   `refreshToken`, `accessToken`, `recoveryCode`, `pollSecret`, `linkToken`, `userCode`, `hwid`, `pow`, at any
 *   depth. The error `code` is not masked.
 * - `X-Request-Id` (API §1.2): a client value matching `^[A-Za-z0-9._-]{8,64}$` is kept, anything else is replaced
 *   by a new UUID; the response always carries it.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { LogController } from "fastify";
import type { FastifyInstance, FastifyRequest, FastifyServerOptions } from "fastify";
import type { Env } from "../config/env.ts";
import { systemClock } from "../lib/clock.ts";
import type { Clock } from "../lib/clock.ts";
import { hmacSha256 } from "../lib/crypto.ts";

export const REDACTED = "[redacted]";

const SECRET_KEYS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "refreshtoken",
  "accesstoken",
  "recoverycode",
  "pollsecret",
  "linktoken",
  "usercode",
  "hwid",
  "pow",
]);

/** Whether a property name holds a secret (case-insensitive; anything containing "password"). */
export function isSecretKey(key: string): boolean {
  const lower = key.toLowerCase();
  return lower.includes("password") || SECRET_KEYS.has(lower);
}

const MAX_MASK_DEPTH = 10;

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * A copy of `value` with every secret property replaced by {@link REDACTED}, at any depth (arrays and plain objects;
 * errors, buffers and class instances are left to their serializers). Cycles and very deep values are cut.
 */
export function maskSecrets(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[circular]";
  if (depth >= MAX_MASK_DEPTH) return "[depth]";
  if (Array.isArray(value)) {
    seen.add(value);
    const copy = value.map((item: unknown) => maskSecrets(item, depth + 1, seen));
    seen.delete(value);
    return copy;
  }
  if (!isPlainObject(value)) return value;
  seen.add(value);
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    copy[key] = isSecretKey(key) ? REDACTED : maskSecrets(item, depth + 1, seen);
  }
  seen.delete(value);
  return copy;
}

type RequestLike = { method?: unknown; url?: unknown; routeOptions?: { url?: unknown } };

/** The request as logs may show it: method and route template (or the path without the query). */
export function serializeRequest(request: unknown): { method: string; url: string } {
  const req = (typeof request === "object" && request !== null ? request : {}) as RequestLike;
  const template = req.routeOptions?.url;
  const raw = typeof req.url === "string" ? req.url : "";
  const path = raw.split("?")[0] ?? "";
  return {
    method: typeof req.method === "string" ? req.method : "",
    url: typeof template === "string" ? template : path,
  };
}

/** Fastify's `logger` option in its object form (Pino options). */
export type LoggerOptions = Exclude<NonNullable<FastifyServerOptions["logger"]>, boolean>;

/** Pino options of the server logger (Fastify `logger`). */
export function loggerOptions(env: Pick<Env, "LOG_LEVEL">): LoggerOptions {
  return {
    level: env.LOG_LEVEL,
    serializers: {
      req: serializeRequest,
      res: (reply: { statusCode?: unknown }) => ({
        statusCode: typeof reply.statusCode === "number" ? reply.statusCode : undefined,
      }),
    },
    formatters: {
      log: (object: Record<string, unknown>) => maskSecrets(object) as Record<string, unknown>,
    },
  };
}

/** Fastify's log controller: no automatic request lines, `reqId` label. */
export function logController(): LogController {
  return new LogController({ disableRequestLogging: true, requestIdLogLabel: "reqId" });
}

export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;

/** The request id: the client's `X-Request-Id` when valid (API §1.2), otherwise a new UUID. */
export function requestIdFrom(header: unknown): string {
  return typeof header === "string" && REQUEST_ID_PATTERN.test(header) ? header : randomUUID();
}

/** Fastify `genReqId`. */
export function genReqId(request: IncomingMessage): string {
  return requestIdFrom(request.headers["x-request-id"]);
}

export type IpTagger = (ip: string) => string;

const DAY_MS = 86_400_000;

/**
 * `ipTag(ip) = hex(HMAC-SHA256(dailyKey, ip))[:12]`: the same address has the same tag within a UTC day and an
 * unrelated tag on the next day; the key never leaves memory.
 */
export function createIpTagger(clock: Clock = systemClock, newKey: () => Buffer = () => randomBytes(32)): IpTagger {
  let day = Number.NaN;
  let key: Buffer = Buffer.alloc(0);
  return (ip: string) => {
    const today = Math.floor(clock.now() / DAY_MS);
    if (today !== day) {
      day = today;
      key = newKey();
    }
    return hmacSha256(key, ip).toString("hex").slice(0, 12);
  };
}

function isHealthRoute(request: FastifyRequest): boolean {
  const url = request.routeOptions.url;
  return url === "/health" || url === "/health/live";
}

/**
 * - `onRequest`: sets `X-Request-Id` on the reply (also for streams that hijack it later);
 * - `onSend`: `Cache-Control: no-store` unless the route set its own (API §1.2: `/server/info` is public for 60 s);
 * - `onResponse`: the request line (`debug` for the health probes, `info` otherwise).
 */
export function registerRequestLogging(app: FastifyInstance): void {
  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-request-id", request.id);
    if (!reply.hasHeader("cache-control")) reply.header("cache-control", "no-store");
    return payload;
  });
  app.addHook("onResponse", async (request, reply) => {
    const line = {
      method: request.method,
      route: request.routeOptions.url ?? null,
      statusCode: reply.statusCode,
      responseTimeMs: Math.round(reply.elapsedTime),
    };
    if (isHealthRoute(request)) request.log.debug(line, "request");
    else request.log.info(line, "request");
  });
}
