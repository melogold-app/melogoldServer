/**
 * HTTP infrastructure in one call, in the order it must be installed (`app.ts` calls it before any route):
 *
 * | Order | What                                 | Hook / phase                                         |
 * | ----- | ------------------------------------ | ---------------------------------------------------- |
 * | 1     | error and 404 handlers               | `setErrorHandler`, `setNotFoundHandler`, `onRequest` |
 * | 2     | `X-Request-Id`, `no-store`, log line | `onRequest`, `onSend`, `onResponse`                  |
 * | 3     | draining (shutdown)                  | `onRequest`                                          |
 * | 4     | route policy (auth, limits, body)    | `onRoute`                                            |
 * | 5     | security headers, CORS, compression  | `onRequest` / `onSend` (preflights before the guard) |
 * | 6     | JSON-only bodies                     | `preParsing`                                         |
 * | 7     | string sanitization                  | `preValidation`                                      |
 * | 8     | `X-Sync-Protocol`                    | `preValidation`                                      |
 * | 9     | Bearer guard                         | `onRequest` (after 1–5)                              |
 * | 10    | rate limits (per route)              | route `onRequest` / `preValidation` (after the guard) |
 * | 11    | disk guard                           | `preHandler`                                         |
 *
 * Fastify runs instance hooks before route hooks, so the guard always runs before the `user`/`device` limits, and
 * sanitization before the `rt`/`ps` limits and the schema. CORS headers are set before the guard, so a browser can
 * read a `401` too.
 */
import type { FastifyInstance, FastifyServerOptions } from "fastify";
import type { Env } from "../config/env.ts";
import type { Subkeys } from "../config/secret-key.ts";
import type { Db } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import type { LruSet } from "../lib/lru.ts";
import { registerAuthGuard } from "./auth-guard.ts";
import { registerBodyRules } from "./body-rules.ts";
import { trustProxyOption } from "./client-ip.ts";
import { registerStorageCheck } from "./disk-guard.ts";
import type { DiskGuard } from "./disk-guard.ts";
import { handleClientError, handleFrameworkError, registerErrorHandler } from "./error-handler.ts";
import { createIpTagger, genReqId, logController, loggerOptions, registerRequestLogging } from "./logging.ts";
import type { IpTagger } from "./logging.ts";
import { registerRateLimits } from "./rate-limit.ts";
import { BODY_LIMITS, registerRoutePolicy } from "./route-policy.ts";
import { registerSanitize } from "./sanitize.ts";
import { registerSyncProtocolCheck } from "./sync-protocol.ts";
import { registerCompression, registerCors, registerDraining, registerSecurityHeaders } from "./web.ts";

/**
 * Fastify constructor options owned by the HTTP layer: logger (masking, no automatic request lines), request ids,
 * `trustProxy` from `TRUST_PROXY`, the default body limit, and the API envelope for the errors raised before routing
 * (`frameworkErrors`) and by Node's HTTP parser (`clientErrorHandler`).
 */
export function fastifyServerOptions(env: Pick<Env, "LOG_LEVEL" | "TRUST_PROXY">): FastifyServerOptions {
  return {
    logger: loggerOptions(env),
    logController: logController(),
    genReqId,
    requestIdHeader: false,
    trustProxy: trustProxyOption(env.TRUST_PROXY),
    bodyLimit: BODY_LIMITS.default,
    frameworkErrors: handleFrameworkError,
    clientErrorHandler: handleClientError,
  };
}

export type HttpInfrastructureDeps = Readonly<{
  env: Pick<Env, "RATE_LIMIT_ENABLED"> & Partial<Pick<Env, "CORS_ORIGINS" | "HTTP_COMPRESSION">>;
  db: Pick<Db, "run">;
  keys: Pick<Subkeys, "jwtAccess" | "refreshToken">;
  clock: Clock;
  diskGuard: Pick<DiskGuard, "assertWritable">;
  ipTag?: IpTagger;
  /** Tests: share or inspect the guard's confirmed-`rid` cache. */
  confirmedRefreshIds?: LruSet<string>;
  /** Tests: jitter of `server_busy` Retry-After. */
  random?: () => number;
  /** Shutdown state (`ctx.lifecycle.isDraining`); default: never draining. */
  isDraining?: () => boolean;
}>;

/** Installs everything above on the root instance. Must be awaited before any route is registered. */
export async function registerHttpInfrastructure(app: FastifyInstance, deps: HttpInfrastructureDeps): Promise<void> {
  const ipTag = deps.ipTag ?? createIpTagger(deps.clock);
  registerErrorHandler(app, deps.random ? { random: deps.random } : {});
  registerRequestLogging(app);
  if (deps.isDraining) registerDraining(app, deps.isDraining);
  registerRoutePolicy(app);
  await registerSecurityHeaders(app);
  await registerCors(app, deps.env.CORS_ORIGINS ?? []);
  await registerCompression(app, deps.env.HTTP_COMPRESSION ?? false);
  registerBodyRules(app);
  registerSanitize(app);
  registerSyncProtocolCheck(app);
  registerAuthGuard(app, {
    db: deps.db,
    accessKey: deps.keys.jwtAccess,
    clock: deps.clock,
    ...(deps.confirmedRefreshIds ? { confirmedRefreshIds: deps.confirmedRefreshIds } : {}),
  });
  await registerRateLimits(app, { enabled: deps.env.RATE_LIMIT_ENABLED, refreshKey: deps.keys.refreshToken, ipTag });
  registerStorageCheck(app, deps.diskGuard);
}

export { AppError, isAppError } from "./errors.ts";
export { requireAuth } from "./auth-guard.ts";
export type { RequestAuth } from "./auth-guard.ts";
