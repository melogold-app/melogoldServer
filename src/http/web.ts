/**
 * Response headers and connection handling (API §1.2):
 *
 * - **CORS.** `Access-Control-Allow-Origin: *` only on the public discovery routes `/server/info`, `/health` and
 *   `/health/live`; every other route follows `CORS_ORIGINS` (exact origins, empty = no CORS at all). Tokens travel in
 *   `Authorization`, never in cookies, so credentials are never allowed. Preflights are answered before the guard.
 * - **Security headers** (`@fastify/helmet`): a `default-src 'none'` CSP for API answers, `nosniff`, no referrer.
 *   HSTS is left to the TLS proxy (Caddy sets it; a LAN server speaks plain http).
 * - **Compression** (`HTTP_COMPRESSION`): gzip for JSON of at least 1 KiB. SSE is never compressed (the stream
 *   hijacks the reply) and request bodies are never decompressed (the body limits of API §1.9 count what arrives).
 * - **Draining** (shutdown): every new request but `/health/live` answers `503 unavailable` with `Connection: close`.
 */
import fastifyCompress from "@fastify/compress";
import fastifyCors from "@fastify/cors";
import type { FastifyCorsOptions } from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import type { FastifyInstance } from "fastify";
import { AppError } from "./errors.ts";

/** API §1.2: the only routes with `Access-Control-Allow-Origin: *`. */
export const PUBLIC_CORS_PATHS: ReadonlySet<string> = new Set(["/server/info", "/health", "/health/live"]);

export const CORS_ALLOWED_HEADERS = ["Authorization", "Content-Type", "X-Sync-Protocol", "X-Request-Id"];
export const CORS_EXPOSED_HEADERS = ["X-Request-Id", "Retry-After", "Content-Disposition"];
const CORS_MAX_AGE_SECONDS = 600;

/** Compression threshold (API §1.2: JSON ≥ 1 KiB). */
export const COMPRESSION_THRESHOLD_BYTES = 1024;

/** `Retry-After` of requests refused while draining. */
export const DRAINING_RETRY_AFTER_SECONDS = 5;

function pathOf(url: string): string {
  const query = url.indexOf("?");
  return query < 0 ? url : url.slice(0, query);
}

/** The CORS options for one request path. */
export function corsOptionsFor(path: string, origins: readonly string[]): FastifyCorsOptions {
  if (PUBLIC_CORS_PATHS.has(path)) {
    return { origin: "*", methods: ["GET", "HEAD"], credentials: false, maxAge: CORS_MAX_AGE_SECONDS };
  }
  if (origins.length === 0) return { origin: false };
  return {
    origin: [...origins],
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: CORS_ALLOWED_HEADERS,
    exposedHeaders: CORS_EXPOSED_HEADERS,
    credentials: false,
    maxAge: CORS_MAX_AGE_SECONDS,
  };
}

export async function registerCors(app: FastifyInstance, origins: readonly string[]): Promise<void> {
  await app.register(fastifyCors, {
    hook: "onRequest",
    delegator: (request, callback) => {
      callback(null, corsOptionsFor(pathOf(request.url), origins));
    },
  });
}

export async function registerSecurityHeaders(app: FastifyInstance): Promise<void> {
  await app.register(fastifyHelmet, {
    global: true,
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    hsts: false,
    referrerPolicy: { policy: "no-referrer" },
  });
}

export async function registerCompression(app: FastifyInstance, enabled: boolean): Promise<void> {
  if (!enabled) return;
  await app.register(fastifyCompress, {
    global: true,
    encodings: ["gzip"],
    threshold: COMPRESSION_THRESHOLD_BYTES,
    customTypes: /^application\/json(?:;|$)/,
    globalDecompression: false,
  });
}

/** Refuses new requests while the server drains (everything but the liveness probe). */
export function registerDraining(app: FastifyInstance, isDraining: () => boolean): void {
  app.addHook("onRequest", (request, reply, done) => {
    if (!isDraining() || pathOf(request.url) === "/health/live") {
      done();
      return;
    }
    void reply.header("connection", "close");
    done(new AppError("unavailable", { details: { retryAfterSeconds: DRAINING_RETRY_AFTER_SECONDS } }));
  });
}
