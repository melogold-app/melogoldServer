/**
 * Routes of the `account` module (API §4.5, T1.3): password change, recovery code rotation and confirmation, account
 * deletion, recovery by code, export.
 *
 * M0: development stubs with their complete schemas (PLAN step 0.8); every handler answers `501 not_implemented`.
 * T1.3 declares `recoveryCode`, `export` and `accountDeletion` in `ctx.features`.
 */
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
import { notImplemented, operation } from "../../http/operation.ts";

const PASSWORD_POLICY_CODES = [
  "password_too_short",
  "password_too_long",
  "password_too_common",
  "password_contains_login",
] as const;

export function registerAccountRoutes(app: FastifyInstance, _ctx: AppContext): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();

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
    notImplemented,
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
    notImplemented,
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
    notImplemented,
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
    notImplemented,
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
    notImplemented,
  );

  routes.get(
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
    notImplemented,
  );
}
