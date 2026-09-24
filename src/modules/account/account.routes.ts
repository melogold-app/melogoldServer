/**
 * Routes of the `account` module (API §4.5, PLAN T1.3): password change, recovery code rotation and confirmation,
 * account deletion, recovery by code, export. Schemas and the service call only; the HTTP policy of every route
 * (auth, body limit, rate limits: `me/password`, `me/recovery-code`, `me/delete` 5/h per user, export 3/h per user,
 * recover 20/h per IP) comes from `src/http/route-policy.ts`.
 *
 * The module declares `recoveryCode`, `export` and `accountDeletion` in `/server/info.features` (API §4.2).
 */
import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { AppContext } from "../../context.ts";
import {
  ChangePasswordRequest,
  ChangePasswordResponse,
  ConfirmRecoveryCodeRequest,
  DeleteAccountRequest,
  ExportDocument,
  RecoverRequest,
  RecoveryCodeResponse,
  RotateRecoveryCodeRequest,
} from "../../contract/account.ts";
import { AuthSession } from "../../contract/common.ts";
import { requireAuth } from "../../http/auth-guard.ts";
import { operation } from "../../http/operation.ts";
import { FEATURE_V1 } from "../server/features.ts";
import { createAccountService } from "./account.service.ts";
import { createPasswordHasher } from "./credentials.ts";
import { contentDisposition, prepareExport } from "./export.ts";

const PASSWORD_POLICY_CODES = [
  "password_too_short",
  "password_too_long",
  "password_too_common",
  "password_contains_login",
] as const;

export function registerAccountRoutes(app: FastifyInstance, ctx: AppContext): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const service = createAccountService({ ctx, passwords: createPasswordHasher(ctx.env) });

  ctx.features.declare("recoveryCode", FEATURE_V1);
  ctx.features.declare("export", FEATURE_V1);
  ctx.features.declare("accountDeletion", FEATURE_V1);

  routes.post(
    "/auth/recover",
    {
      schema: operation("POST", "/auth/recover", {
        operationId: "recoverAccount",
        tag: "account",
        summary: "Reset the password with the recovery code",
        description:
          "Every previous device is removed (session.invalidated{recovery_reset}); the new one has linkedVia=recovery. " +
          "`recoveryCode` of the answer is the new code. Not retried automatically: after a network error log in " +
          "with the new password (API §4.5).",
        body: RecoverRequest,
        status: 200,
        response: AuthSession,
        errors: [...PASSWORD_POLICY_CODES, "invalid_recovery_code"],
      }),
    },
    (request) => service.recover(request.body),
  );

  routes.post(
    "/auth/me/password",
    {
      schema: operation("POST", "/auth/me/password", {
        operationId: "changePassword",
        tag: "account",
        summary: "Change the password",
        description:
          "Without `currentPassword` the change is allowed from any signed-in device; the others get " +
          "account.updated{password_changed_without_old}. Always bumps auth_version (API §4.5).",
        body: ChangePasswordRequest,
        status: 200,
        response: ChangePasswordResponse,
        errors: [...PASSWORD_POLICY_CODES, "invalid_password", "reauth_throttled"],
      }),
    },
    (request) => service.changePassword(requireAuth(request), request.body),
  );

  routes.post(
    "/auth/me/recovery-code",
    {
      schema: operation("POST", "/auth/me/recovery-code", {
        operationId: "rotateRecoveryCode",
        tag: "account",
        summary: "Issue a new recovery code",
        body: RotateRecoveryCodeRequest,
        status: 200,
        response: RecoveryCodeResponse,
        errors: ["invalid_password", "reauth_throttled"],
      }),
    },
    (request) => service.rotateRecoveryCode(requireAuth(request), request.body),
  );

  routes.post(
    "/auth/me/recovery-code/confirm",
    {
      schema: operation("POST", "/auth/me/recovery-code/confirm", {
        operationId: "confirmRecoveryCode",
        tag: "account",
        summary: "Confirm that the recovery code is saved",
        body: ConfirmRecoveryCodeRequest,
        status: 204,
        errors: ["recovery_code_outdated"],
      }),
    },
    async (request, reply) => {
      await service.confirmRecoveryCode(requireAuth(request), request.body);
      return reply.code(204).send();
    },
  );

  routes.post(
    "/auth/me/delete",
    {
      schema: operation("POST", "/auth/me/delete", {
        operationId: "deleteAccount",
        tag: "account",
        summary: "Delete the account",
        description:
          "Logical and immediate: the login is free at once, devices are removed, data is purged by a background job " +
          "(API §4.5).",
        body: DeleteAccountRequest,
        status: 204,
        errors: ["invalid_password", "reauth_throttled"],
      }),
    },
    async (request, reply) => {
      await service.deleteAccount(requireAuth(request), request.body);
      return reply.code(204).send();
    },
  );

  // Registered without the zod type provider: the answer is a stream, which Fastify sends as is (no serializer).
  app.get(
    "/auth/me/export",
    {
      schema: operation("GET", "/auth/me/export", {
        operationId: "exportAccount",
        tag: "account",
        summary: "Export the account as JSON",
        description:
          'Streamed with `Content-Disposition: attachment; filename="melogold-export-<login>-<YYYY-MM-DD>.json"`. ' +
          "Not an atomic snapshot; contains no secrets (API §4.5).",
        status: 200,
        response: ExportDocument,
      }),
    },
    async (request, reply) => {
      const prepared = await prepareExport(ctx, requireAuth(request));
      const log = request.log;
      async function* guarded(): AsyncGenerator<string> {
        try {
          yield* prepared.chunks;
        } catch (error) {
          log.error({ err: error }, "export failed after the response started; the download is cut");
          throw error;
        }
      }
      return reply
        .header("content-disposition", contentDisposition(prepared.filename))
        .type("application/json; charset=utf-8")
        .send(Readable.from(guarded(), { objectMode: false }));
    },
  );
}
