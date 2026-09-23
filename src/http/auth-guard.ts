/**
 * The Bearer guard (API §1.7, DESIGN §4.3): a global `onRequest` hook on every route whose policy is `bearer` —
 * which is every route not explicitly public (closed by default), SSE included (before the hijack).
 *
 * 1. no `Authorization: Bearer <token>` → `401 unauthorized`;
 * 2. bad signature or format → `401 access_token_invalid`; expired → `401 access_token_expired`;
 * 3. one query `devices ⋈ users` by `did`, `sub` and `users.deleted_at IS NULL`; no row → `401 session_revoked`;
 * 4. `users.auth_version ≠ av` → `401 access_token_expired`;
 * 5. `rid` confirmation: unless `rid` is in the process LRU set,
 *    `UPDATE refresh_tokens SET confirmed_at = now WHERE id = rid AND confirmed_at IS NULL`, then remember `rid`;
 *    a failure of this write does not fail the request;
 * 6. `devices.last_seen_at` is written at most once per 5 minutes (a failure does not fail the request either).
 *
 * On Bearer routes 401 means only a token or session problem.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Db } from "../db/index.ts";
import { MINUTE_MS } from "../lib/clock.ts";
import type { Clock } from "../lib/clock.ts";
import { LruSet } from "../lib/lru.ts";
import { verifyAccessToken } from "../lib/tokens.ts";
import { AppError } from "./errors.ts";

/** The authenticated caller of a Bearer route. */
export type RequestAuth = Readonly<{
  userId: string;
  deviceId: string;
  /** `av` of the token (= `users.auth_version` at step 4). */
  authVersion: number;
  /** `rid`: the refresh token issued together with the access token. */
  refreshId: string;
  /** `iat` in epoch milliseconds. */
  tokenIssuedAt: number;
  /** `exp` in epoch milliseconds: SSE closes the stream at this moment (DESIGN §4.7). */
  tokenExpiresAt: number;
}>;

declare module "fastify" {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- module augmentation needs an interface
  interface FastifyRequest {
    /** Set by the guard on Bearer routes; `null` elsewhere. */
    auth: RequestAuth | null;
  }
}

export const LAST_SEEN_INTERVAL_MS = 5 * MINUTE_MS;
export const CONFIRMED_RID_CACHE_SIZE = 10_000;

export type AuthGuardLogger = Readonly<{ warn(details: object, message: string): void }>;

export type AuthGuardDeps = Readonly<{
  db: Pick<Db, "run">;
  /** HKDF subkey `melogold/jwt-access/v1`. */
  accessKey: Uint8Array;
  clock: Clock;
  /** Refresh ids already confirmed by this process (default: a new LRU of 10 000). */
  confirmedRefreshIds?: LruSet<string>;
  lastSeenIntervalMs?: number;
}>;

const BEARER = /^Bearer +(\S+) *$/i;

/** The token of an `Authorization` header, or `null` when there is no Bearer credential. */
export function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  return BEARER.exec(header)?.[1] ?? null;
}

/**
 * Runs steps 1–6 for one request.
 * @throws AppError `unauthorized`, `access_token_invalid`, `access_token_expired` or `session_revoked`.
 */
export async function authenticate(
  deps: AuthGuardDeps & Readonly<{ confirmedRefreshIds: LruSet<string> }>,
  authorization: string | undefined,
  log: AuthGuardLogger,
): Promise<RequestAuth> {
  const token = bearerToken(authorization);
  if (token === null) throw new AppError("unauthorized");

  const verified = verifyAccessToken(token, deps.accessKey, deps.clock.now());
  if (!verified.ok) throw new AppError(verified.reason === "expired" ? "access_token_expired" : "access_token_invalid");
  const { sub, did, av, rid, iat, exp } = verified.claims;

  const session = await deps.db.run((q) =>
    q
      .selectFrom("devices")
      .innerJoin("users", "users.id", "devices.user_id")
      .select(["devices.last_seen_at as lastSeenAt", "users.auth_version as authVersion"])
      .where("devices.id", "=", did)
      .where("devices.user_id", "=", sub)
      .where("users.deleted_at", "is", null)
      .executeTakeFirst(),
  );
  if (!session) throw new AppError("session_revoked");
  if (session.authVersion !== av) throw new AppError("access_token_expired");

  const now = deps.clock.now();
  if (!deps.confirmedRefreshIds.has(rid)) {
    try {
      await deps.db.run((q) =>
        q
          .updateTable("refresh_tokens")
          .set({ confirmed_at: now })
          .where("id", "=", rid)
          .where("confirmed_at", "is", null)
          .execute(),
      );
      deps.confirmedRefreshIds.add(rid);
    } catch (error) {
      log.warn({ err: error }, "could not confirm the refresh token of an access token");
    }
  }

  const interval = deps.lastSeenIntervalMs ?? LAST_SEEN_INTERVAL_MS;
  if (now - session.lastSeenAt >= interval) {
    try {
      await deps.db.run((q) =>
        q
          .updateTable("devices")
          .set({ last_seen_at: now })
          .where("id", "=", did)
          .where("last_seen_at", "<=", now - interval)
          .execute(),
      );
    } catch (error) {
      log.warn({ err: error }, "could not update devices.last_seen_at");
    }
  }

  return Object.freeze({
    userId: sub,
    deviceId: did,
    authVersion: av,
    refreshId: rid,
    tokenIssuedAt: iat * 1000,
    tokenExpiresAt: exp * 1000,
  });
}

/** Installs the guard. Routes resolve their policy through `registerRoutePolicy`; a route without one is Bearer. */
export function registerAuthGuard(app: FastifyInstance, deps: AuthGuardDeps): void {
  const resolved = {
    ...deps,
    confirmedRefreshIds: deps.confirmedRefreshIds ?? new LruSet<string>(CONFIRMED_RID_CACHE_SIZE),
  };
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    if (request.is404) return;
    const auth = request.routeOptions.config.policy?.auth ?? "bearer";
    if (auth !== "bearer") return;
    request.auth = await authenticate(resolved, request.headers.authorization, request.log);
  });
}

/** The caller of a Bearer route (the guard ran); throws `401 unauthorized` if called elsewhere by mistake. */
export function requireAuth(request: Pick<FastifyRequest, "auth">): RequestAuth {
  if (request.auth === null) throw new AppError("unauthorized");
  return request.auth;
}
