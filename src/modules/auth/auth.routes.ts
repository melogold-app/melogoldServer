/**
 * Routes of the `auth` module (API §4.3, T1.1): registration challenge, register, login, refresh, logout, `GET /auth/me`.
 * Routes only validate and call the services (`auth.service.ts`, `refresh.service.ts`).
 *
 * - `POST /auth/register` checks the registration mode and the proof of work in a route `preValidation` hook, i.e.
 *   before its schema (DESIGN §4.2: mode → PoW → schema → …); instance hooks (sanitization) run before it.
 * - `features.registrationPow` of `/server/info` is present while proof of work is required (API §4.2).
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { AppContext } from "../../context.ts";
import {
  LoginRequest,
  LogoutRequest,
  MeResponse,
  RefreshRequest,
  RefreshResponse,
  RegisterChallenge,
  RegisterRequest,
} from "../../contract/auth.ts";
import { AuthSession } from "../../contract/common.ts";
import { requireAuth } from "../../http/auth-guard.ts";
import { operation } from "../../http/operation.ts";
import { FEATURE_V1 } from "../server/features.ts";
import { createAuthService } from "./auth.service.ts";
import { createRefreshService } from "./refresh.service.ts";

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const auth = createAuthService(ctx);
  const sessions = createRefreshService(ctx);
  ctx.features.declare("registrationPow", () => (auth.pow.requiredBits(ctx.clock.now()) > 0 ? FEATURE_V1 : null));

  routes.get(
    "/auth/register/challenge",
    {
      schema: operation("GET", "/auth/register/challenge", {
        operationId: "getRegisterChallenge",
        tag: "auth",
        summary: "Proof-of-work challenge for registration",
        description:
          'Find the first nonce "0", "1", … such that sha256(UTF-8(challenge + ":" + nonce)) starts with `bits` zero ' +
          "bits. One use, valid for 10 minutes (API §4.3).",
        status: 200,
        response: RegisterChallenge,
      }),
    },
    () => Promise.resolve(auth.challenge()),
  );

  routes.post(
    "/auth/register",
    {
      schema: operation("POST", "/auth/register", {
        operationId: "register",
        tag: "auth",
        summary: "Create an account, its first device and a recovery code",
        description:
          "Order of checks: registration mode → proof of work → schema → login → taken → password policy (API §4.3). " +
          "`recoveryCode` of the answer is not null. Not retried automatically: after a network error try login.",
        body: RegisterRequest,
        status: 201,
        response: AuthSession,
        errors: [
          "invalid_login_format",
          "password_too_short",
          "password_too_long",
          "password_too_common",
          "password_contains_login",
          "registration_closed",
          "pow_required",
          "pow_invalid",
          "login_taken",
        ],
      }),
      preValidation: (request) => auth.registrationGate(request.body),
    },
    async (request, reply) => {
      const session = await auth.register(request.body);
      return reply.code(201).send(session);
    },
  );

  routes.post(
    "/auth/login",
    {
      schema: operation("POST", "/auth/login", {
        operationId: "login",
        tag: "auth",
        summary: "Sign in with login and password",
        description:
          "A known (user, hwid) reuses its device row; a new device is created with linkedVia=login and counts as new " +
          "(`recentUntil`). `device_limit_reached` comes only after a correct password (API §4.3).",
        body: LoginRequest,
        status: 200,
        response: AuthSession,
        errors: ["invalid_credentials", "device_limit_reached", "login_throttled"],
      }),
    },
    (request) => auth.login(request.body),
  );

  routes.post(
    "/auth/refresh",
    {
      schema: operation("POST", "/auth/refresh", {
        operationId: "refreshSession",
        tag: "auth",
        summary: "Rotate the refresh token",
        description:
          "Retried automatically: within REFRESH_GRACE_SECONDS the same unconfirmed successor is returned. Any 401 → " +
          "AuthRequired (API §1.7, §4.3).",
        body: RefreshRequest,
        status: 200,
        response: RefreshResponse,
        errors: ["session_revoked", "invalid_refresh_token", "refresh_token_reused", "device_mismatch"],
      }),
    },
    (request) => sessions.refresh(request.body),
  );

  routes.post(
    "/auth/logout",
    {
      schema: operation("POST", "/auth/logout", {
        operationId: "logout",
        tag: "auth",
        summary: "Remove this device (sign out)",
        description:
          "Always 204. Acts only with the current token or one within the grace window; the other devices get " +
          "devices.updated{device_signed_out} (API §4.3).",
        body: LogoutRequest,
        status: 204,
      }),
    },
    async (request, reply) => {
      await sessions.logout(request.body);
      return reply.code(204).send();
    },
  );

  routes.get(
    "/auth/me",
    {
      schema: operation("GET", "/auth/me", {
        operationId: "getMe",
        tag: "auth",
        summary: "Profile and the current device",
        status: 200,
        response: MeResponse,
      }),
    },
    (request) => auth.me(requireAuth(request)),
  );
}
