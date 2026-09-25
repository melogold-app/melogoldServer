/**
 * Route schemas with their OpenAPI operation (API §1.1, §3): every route of API §3 except `GET /` and
 * `GET /openapi.json` is declared through {@link operation}, which returns the Fastify `schema` with
 *
 * - `operationId`, one tag, a summary and a description (with the rate limits of API §1.10);
 * - `security`: `bearerAuth` on Bearer routes, none elsewhere (refresh tokens and poll secrets travel in the body);
 * - the request body and path parameters (validated by zod), the success response (serialized by zod);
 * - one `ErrorResponse` per error status, with the codes of that status: the route's own codes plus the ones its
 *   policy implies (`route-policy.ts`): Bearer → the four 401 codes; a body → `invalid_request`, `invalid_json`,
 *   `payload_too_large`, `unsupported_media_type`; a rate limit → `rate_limited`; `X-Sync-Protocol` →
 *   `invalid_request`, `protocol_unsupported`; the storage check → `storage_full`; database → `server_busy`,
 *   `unavailable`; always `internal_error`.
 *
 * `501 not_implemented` (development stubs, {@link notImplemented}) is never documented.
 */
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { ErrorResponse } from "../contract/common.ts";
import { requiresJsonBody } from "./body-rules.ts";
import { ALL_ERROR_CODES, ERROR_CODES } from "./error-codes.ts";
import type { ErrorCode } from "./error-codes.ts";
import { AppError } from "./errors.ts";
import { resolveRoutePolicy } from "./route-policy.ts";
import type { RateLimitRule } from "./route-policy.ts";

/** OpenAPI tags, one per module (DESIGN §2). */
export const OPENAPI_TAGS = Object.freeze([
  { name: "server", description: "Health and discovery (API §4.2)." },
  { name: "auth", description: "Registration, login and sessions (API §4.3)." },
  { name: "devices", description: "The devices of the account (API §4.4)." },
  { name: "account", description: "Password, recovery code, account deletion and export (API §4.5)." },
  { name: "linking", description: "Linking a new device by QR code or user code (API §4.6)." },
  { name: "live", description: "Server-sent events (API §6)." },
  { name: "sync", description: "Library and history synchronization (API §4.7, §4.8)." },
  { name: "playback", description: "Continue playback on another device (API §4.9)." },
  { name: "lyrics", description: "The user's lyrics and the shared ones (API §4.10)." },
] as const);

export type OpenapiTag = (typeof OPENAPI_TAGS)[number]["name"];

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type SuccessStatus = 200 | 201 | 204;

export const BEARER_SECURITY_SCHEME = "bearerAuth";
export const EVENT_STREAM = "text/event-stream";

export type OperationSpec<
  S extends SuccessStatus = SuccessStatus,
  R extends z.ZodType | undefined = z.ZodType | undefined,
  B extends z.ZodType | undefined = z.ZodType | undefined,
  P extends z.ZodType | undefined = z.ZodType | undefined,
> = Readonly<{
  /** The `operationId` of API §3. */
  operationId: string;
  tag: OpenapiTag;
  summary: string;
  description?: string;
  /** Validated request body (a registered contract component). */
  body?: B;
  /** Documented instead of `body` when the route validates a looser schema (`POST /sync`, DESIGN §3.9). */
  documentedBody?: z.ZodType;
  /** Path parameters (`DeviceIdParams`, `LinkIdParams`). */
  params?: P;
  /** The 2xx status of API §3. */
  status: S;
  /** Response body of `status` (a registered contract component); none for 204. */
  response?: R;
  /** Media type of the success response: JSON by default, `text/event-stream` for SSE. */
  contentType?: typeof EVENT_STREAM;
  /** Codes of this route besides the ones its policy implies. */
  errors?: readonly ErrorCode[];
  /** `false`: the route never touches the database (no `server_busy` / `unavailable`). */
  database?: boolean;
}>;

/**
 * The schema {@link operation} returns, typed for the zod type provider: `request.body`, `request.params` and the
 * handler's return value follow the zod schemas (error statuses are only thrown, never returned).
 */
export type OperationSchema<
  S extends SuccessStatus,
  R extends z.ZodType | undefined,
  B extends z.ZodType | undefined,
  P extends z.ZodType | undefined,
> = FastifySchema & {
  body: B;
  params: P;
  response: Record<S, R extends z.ZodType ? R : z.ZodUndefined>;
};

declare module "fastify" {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- module augmentation needs an interface
  interface FastifySchema {
    /** Error codes of each documented error status; set by {@link operation}, read by the OpenAPI transform. */
    errorCodes?: Readonly<Record<string, readonly ErrorCode[]>>;
    /** OpenAPI request body when it differs from the validated `body`. */
    documentedBody?: unknown;
  }
}

const BEARER_CODES: readonly ErrorCode[] = [
  "unauthorized",
  "access_token_invalid",
  "access_token_expired",
  "session_revoked",
];
const BODY_CODES: readonly ErrorCode[] = [
  "invalid_request",
  "invalid_json",
  "payload_too_large",
  "unsupported_media_type",
];
const DATABASE_CODES: readonly ErrorCode[] = ["server_busy", "unavailable"];

/** Every error code a route may answer (without `not_implemented`), in registry order. */
export function operationErrorCodes(
  method: HttpMethod,
  url: string,
  spec: Pick<OperationSpec, "errors" | "database" | "params">,
): ErrorCode[] {
  const policy = resolveRoutePolicy(method, url);
  const codes = new Set<ErrorCode>(spec.errors ?? []);
  codes.add("internal_error");
  if (spec.database !== false) for (const code of DATABASE_CODES) codes.add(code);
  if (policy.auth === "bearer") for (const code of BEARER_CODES) codes.add(code);
  if (requiresJsonBody(method)) for (const code of BODY_CODES) codes.add(code);
  if (spec.params !== undefined) codes.add("invalid_request");
  if (policy.rateLimits.length > 0) codes.add("rate_limited");
  if (policy.syncProtocol) {
    codes.add("invalid_request");
    codes.add("protocol_unsupported");
  }
  if (policy.storage !== null) codes.add("storage_full");
  codes.delete("not_implemented");
  return ALL_ERROR_CODES.filter((code) => codes.has(code));
}

/** Error codes grouped by HTTP status (keys in ascending order). */
export function errorCodesByStatus(codes: readonly ErrorCode[]): Record<string, ErrorCode[]> {
  const grouped: Record<string, ErrorCode[]> = {};
  const statuses = [...new Set(codes.map((code) => ERROR_CODES[code].status))].sort((a, b) => a - b);
  for (const status of statuses) grouped[String(status)] = codes.filter((code) => ERROR_CODES[code].status === status);
  return grouped;
}

function windowText(windowMs: number): string {
  const minutes = windowMs / 60_000;
  if (minutes === 60) return "hour";
  if (minutes === 1) return "min";
  return Number.isInteger(minutes) ? `${minutes} min` : `${windowMs / 1000} s`;
}

const KEY_TEXT: Readonly<Record<RateLimitRule["key"], string>> = {
  ip: "IP (IPv6 by /56)",
  user: "user",
  device: "device",
  rt: "refresh token",
  ps: "poll secret",
};

/** "Rate limit: 30/min per IP (IPv6 by /56)." (API §1.10). */
export function rateLimitText(rules: readonly RateLimitRule[]): string | null {
  if (rules.length === 0) return null;
  const parts = rules.map((rule) => `${rule.max}/${windowText(rule.windowMs)} per ${KEY_TEXT[rule.key]}`);
  return `Rate limit: ${parts.join(" and ")} (API §1.10).`;
}

/**
 * The Fastify schema of one operation.
 * @param method the method of the route (`HEAD` is added by Fastify for GET routes).
 * @param url the Fastify path (`/auth/me/devices/:deviceId`).
 */
export function operation<
  const S extends SuccessStatus,
  R extends z.ZodType | undefined = undefined,
  B extends z.ZodType | undefined = undefined,
  P extends z.ZodType | undefined = undefined,
>(method: HttpMethod, url: string, spec: OperationSpec<S, R, B, P>): OperationSchema<S, R, B, P> {
  if (spec.status === 204 && spec.response !== undefined) throw new TypeError(`${spec.operationId}: 204 has no body`);
  if (spec.status !== 204 && spec.response === undefined) {
    throw new TypeError(`${spec.operationId}: a ${spec.status} response needs a schema`);
  }
  const policy = resolveRoutePolicy(method, url);
  const errorCodes = errorCodesByStatus(operationErrorCodes(method, url, spec));

  const response: Record<string, unknown> = {};
  if (spec.response === undefined) {
    response[String(spec.status)] = z.undefined();
  } else if (spec.contentType === EVENT_STREAM) {
    response[String(spec.status)] = { content: { [EVENT_STREAM]: { schema: spec.response } } };
  } else {
    response[String(spec.status)] = spec.response;
  }
  for (const status of Object.keys(errorCodes)) response[status] = ErrorResponse;

  const description = [spec.description, rateLimitText(policy.rateLimits)].filter(Boolean).join("\n\n");
  const schema: FastifySchema = {
    operationId: spec.operationId,
    tags: [spec.tag],
    summary: spec.summary,
    ...(description === "" ? {} : { description }),
    security: policy.auth === "bearer" ? [{ [BEARER_SECURITY_SCHEME]: [] }] : [],
    ...(spec.body === undefined ? {} : { body: spec.body }),
    ...(spec.documentedBody === undefined ? {} : { documentedBody: spec.documentedBody }),
    ...(spec.params === undefined ? {} : { params: spec.params }),
    response,
    errorCodes,
  };
  return schema as OperationSchema<S, R, B, P>;
}

/**
 * The handler of a development stub (PLAN M0 step 0.8): the request passed authentication, limits and validation,
 * then `501 not_implemented`.
 */
export function notImplemented(): Promise<never> {
  return Promise.reject(new AppError("not_implemented"));
}
