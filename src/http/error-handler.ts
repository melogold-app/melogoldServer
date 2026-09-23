/**
 * The error contract (API §2.1): every refusal is
 * `{statusCode, error: message, message, code, ...details}` with `code` from the registry, never with status 200.
 *
 * {@link registerErrorHandler} installs the handler **before any route is registered** (API §2.1; a plugin
 * registered earlier would capture Fastify's default handler, the lesson of `C/app.ts`), the 404 handler, and an
 * early `onRequest` hook that answers unknown routes with `404 not_found` before authentication or body parsing.
 *
 * {@link toErrorReply} is the pure mapping:
 *
 * | Error                                                         | Answer                                          |
 * | ------------------------------------------------------------- | ----------------------------------------------- |
 * | `AppError`                                                    | its code; 5xx with the generic message          |
 * | schema validation (zod provider or ajv), `ZodError`           | `400 invalid_request` with `issues`             |
 * | empty or malformed JSON body                                  | `400 invalid_json`                              |
 * | body over the route limit                                     | `413 payload_too_large`                         |
 * | content type without a parser                                 | `415 unsupported_media_type`                    |
 * | full argon2 queue (`SemaphoreFullError`)                      | `503 server_busy`, Retry-After 5                |
 * | busy / unreachable / full database (`src/db/errors.ts`)       | `503 server_busy` / `unavailable` / `storage_full` |
 * | other 4xx of Fastify or plugins                               | by status: 400/404/413/415/429, else 400        |
 * | anything else (bugs, constraint violations, serialization)    | `500 internal_error`, logged                    |
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from "fastify-type-provider-zod";
import { z } from "zod";
import { translateDbError } from "../db/errors.ts";
import { SemaphoreFullError } from "../lib/semaphore.ts";
import { ERROR_CODES } from "./error-codes.ts";
import type { ErrorCode, ErrorDetailKey, ErrorDetailValues, ValidationIssue } from "./error-codes.ts";
import { AppError, isAppError } from "./errors.ts";

/** API §2.1 `ErrorResponse`. */
export type ErrorResponseBody = Readonly<
  {
    statusCode: number;
    error: string;
    message: string;
    code: ErrorCode;
  } & Partial<ErrorDetailValues>
>;

export type ErrorReply = Readonly<{
  statusCode: number;
  body: ErrorResponseBody;
  headers: Readonly<Record<string, string>>;
  /** How the handler logs it: 500 is a bug (`error`), 503 a condition (`warn`), 501 and 4xx are not logged. */
  log: "none" | "warn" | "error";
}>;

/** More issues than this are cut: the client learns enough to bisect its batch (DESIGN §3.9). */
export const MAX_VALIDATION_ISSUES = 100;
/** `503 server_busy` for a full argon2 queue (DESIGN §4.1: `server_busy{5}`). */
export const SEMAPHORE_RETRY_AFTER_SECONDS = 5;

type ErrorLike = { code?: unknown; statusCode?: unknown; validation?: unknown; validationContext?: unknown };

function asRecord(error: unknown): ErrorLike | null {
  return typeof error === "object" && error !== null ? error : null;
}

/** Builds the reply for a registry code; details not allowed for the code are dropped. */
export function errorReply(
  code: ErrorCode,
  options: Readonly<{
    message?: string;
    details?: Readonly<Partial<ErrorDetailValues>>;
    headers?: Readonly<Record<string, string>>;
  }> = {},
): ErrorReply {
  const spec = ERROR_CODES[code];
  const status = spec.status;
  const message =
    status >= 500 || options.message === undefined || options.message === "" ? spec.message : options.message;
  const allowed = new Set<ErrorDetailKey>([...spec.required, ...spec.optional]);
  const details: Partial<Record<ErrorDetailKey, unknown>> = {};
  for (const key of allowed) {
    const value = options.details?.[key];
    if (value !== undefined) details[key] = value;
  }
  const headers: Record<string, string> = { ...options.headers };
  const retryAfter = details.retryAfterSeconds;
  if ((status === 429 || status === 503) && typeof retryAfter === "number") {
    headers["retry-after"] = String(retryAfter);
  }
  const body = { statusCode: status, error: message, message, code, ...details } as ErrorResponseBody;
  // 500 is a bug; 503 is a server condition; 501 answers the development stubs and is expected, like 4xx.
  const log = status === 500 ? "error" : status === 503 ? "warn" : "none";
  return Object.freeze({ statusCode: status, body: Object.freeze(body), headers: Object.freeze(headers), log });
}

function issuePath(context: unknown, instancePath: unknown): string {
  const path = typeof instancePath === "string" ? instancePath.replace(/^\//, "").split("/").join(".") : "";
  if (typeof context !== "string" || context === "body") return path;
  return path === "" ? context : `${context}.${path}`;
}

/** `issues` of a Fastify validation error (the zod provider and ajv both fill `validation`). */
export function validationIssues(error: unknown): ValidationIssue[] | null {
  const record = asRecord(error);
  if (!record || !Array.isArray(record.validation)) return null;
  const issues: ValidationIssue[] = [];
  for (const entry of record.validation.slice(0, MAX_VALIDATION_ISSUES)) {
    const item = asRecord(entry) as { instancePath?: unknown; keyword?: unknown } | null;
    issues.push({
      path: issuePath(record.validationContext, item?.instancePath),
      code: typeof item?.keyword === "string" ? item.keyword : "invalid",
    });
  }
  return issues;
}

/** `issues` of a `ZodError` thrown by code (not by the route schema). */
export function zodIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues
    .slice(0, MAX_VALIDATION_ISSUES)
    .map((issue) => ({ path: issue.path.map(String).join("."), code: issue.code }));
}

const FASTIFY_CODES: Readonly<Record<string, ErrorCode>> = {
  FST_ERR_CTP_EMPTY_JSON_BODY: "invalid_json",
  FST_ERR_CTP_INVALID_JSON_BODY: "invalid_json",
  FST_ERR_CTP_INVALID_MEDIA_TYPE: "unsupported_media_type",
  FST_ERR_CTP_BODY_TOO_LARGE: "payload_too_large",
  FST_ERR_NOT_FOUND: "not_found",
};

function byStatus(status: number): ErrorReply {
  switch (status) {
    case 404:
      return errorReply("not_found");
    case 413:
      return errorReply("payload_too_large");
    case 415:
      return errorReply("unsupported_media_type");
    case 429:
      return errorReply("rate_limited", { details: { retryAfterSeconds: 60 } });
    default:
      return errorReply("invalid_request", { details: { issues: [] } });
  }
}

/**
 * Maps any thrown value to the reply of API §2.
 * @param random jitter for `server_busy`'s Retry-After (tests inject it).
 */
export function toErrorReply(error: unknown, random: () => number = Math.random): ErrorReply {
  if (isAppError(error)) {
    return errorReply(error.code, { message: error.message, details: error.details, headers: error.headers });
  }
  if (hasZodFastifySchemaValidationErrors(error) || asRecord(error)?.code === "FST_ERR_VALIDATION") {
    return errorReply("invalid_request", { details: { issues: validationIssues(error) ?? [] } });
  }
  if (error instanceof z.ZodError) {
    return errorReply("invalid_request", { details: { issues: zodIssues(error) } });
  }
  if (error instanceof SemaphoreFullError) {
    return errorReply("server_busy", { details: { retryAfterSeconds: SEMAPHORE_RETRY_AFTER_SECONDS } });
  }
  const record = asRecord(error);
  if (record && isResponseSerializationError(record)) return errorReply("internal_error");
  const mapped = typeof record?.code === "string" ? FASTIFY_CODES[record.code] : undefined;
  if (mapped === "invalid_json" || mapped === "unsupported_media_type" || mapped === "payload_too_large") {
    return errorReply(mapped);
  }
  if (mapped === "not_found") return errorReply("not_found");
  const database = translateDbError(error, random);
  if (database) return errorReply(database.code, { details: { retryAfterSeconds: database.retryAfterSeconds } });
  const status = record?.statusCode;
  if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status < 500) return byStatus(status);
  return errorReply("internal_error");
}

/** Sends an error reply. JSON errors are never cached (API §1.2). */
export function sendErrorReply(reply: FastifyReply, errorReplyValue: ErrorReply): FastifyReply {
  return reply
    .code(errorReplyValue.statusCode)
    .headers({ ...errorReplyValue.headers, "cache-control": "no-store" })
    .type("application/json; charset=utf-8")
    .send(errorReplyValue.body);
}

function logError(request: FastifyRequest, error: unknown, plan: ErrorReply): void {
  if (plan.log === "error") {
    request.log.error({ err: error, code: plan.body.code }, "request failed");
  } else if (plan.log === "warn") {
    request.log.warn({ err: error, code: plan.body.code }, "request refused: server condition");
  }
}

export type ErrorHandlerOptions = Readonly<{
  /** Jitter for `server_busy` Retry-After (tests). */
  random?: () => number;
}>;

/**
 * Installs the error handler, the 404 handler and the early 404 hook on the root instance. Call it before registering
 * any route or route plugin.
 */
export function registerErrorHandler(app: FastifyInstance, options: ErrorHandlerOptions = {}): void {
  const random = options.random ?? Math.random;

  app.setErrorHandler((error, request, reply) => {
    const plan = toErrorReply(error, random);
    logError(request, error, plan);
    return sendErrorReply(reply, plan);
  });

  app.setNotFoundHandler((_request, reply) => sendErrorReply(reply, errorReply("not_found")));

  // Unknown routes answer 404 before the guard, the rate limits and body parsing: `GET /nope` without a token is
  // `404 not_found`, not `401`, and a body sent to it is never read.
  app.addHook("onRequest", (request, _reply, done) => {
    done(request.is404 ? new AppError("not_found") : undefined);
  });
}
