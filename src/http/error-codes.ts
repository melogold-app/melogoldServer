/**
 * The registry of error codes (API §2). Frozen after M0 (PLAN, general rules item 2); a new code starts with an edit
 * of `docs/API.md`. `scripts/gen-error-codes.ts` turns it into `spec/error-codes.json`.
 *
 * Clients branch **only** on `code`. `message` is English text for logs, never for UI or logic; 5xx always carry the
 * generic message of their code. Details (`retryAfterSeconds`, `issues`, …) appear only with the codes listed here.
 */

/** API §2.1 `ValidationIssue`: path like `ops.3.opId`, zod issue code like `invalid_type`. */
export type ValidationIssue = Readonly<{ path: string; code: string }>;

/** Every detail field of API §2.1 `ErrorResponse` and its type. */
export type ErrorDetailValues = {
  retryAfterSeconds: number;
  issues: readonly ValidationIssue[];
  minLength: number;
  maxLength: number;
  deviceLimit: number;
  deviceCount: number;
  minProtocol: number;
  maxProtocol: number;
  floorCursor: string;
  minDeviceAgeDays: number;
};

export type ErrorDetailKey = keyof ErrorDetailValues;

export const ERROR_DETAIL_KEYS: readonly ErrorDetailKey[] = Object.freeze([
  "retryAfterSeconds",
  "issues",
  "minLength",
  "maxLength",
  "deviceLimit",
  "deviceCount",
  "minProtocol",
  "maxProtocol",
  "floorCursor",
  "minDeviceAgeDays",
]);

export type ErrorCodeSpec = Readonly<{
  status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 415 | 429 | 500 | 501 | 503;
  /** Default English message (the only message 5xx ever send). */
  message: string;
  /** Details always present with this code. */
  required: readonly ErrorDetailKey[];
  /** Details that may be present with this code. */
  optional: readonly ErrorDetailKey[];
}>;

const none = [] as const;

/** API §2.2, in the order of its table. */
export const ERROR_CODES = {
  // 400
  invalid_request: { status: 400, message: "Invalid request", required: ["issues"], optional: none },
  invalid_json: { status: 400, message: "Request body is not valid JSON", required: none, optional: none },
  invalid_login_format: { status: 400, message: "Invalid login format", required: none, optional: none },
  password_too_short: { status: 400, message: "Password is too short", required: ["minLength"], optional: none },
  password_too_long: { status: 400, message: "Password is too long", required: ["maxLength"], optional: none },
  password_too_common: { status: 400, message: "Password is too common", required: none, optional: none },
  password_contains_login: { status: 400, message: "Password contains the login", required: none, optional: none },
  // 401
  unauthorized: { status: 401, message: "Authorization required", required: none, optional: none },
  access_token_invalid: { status: 401, message: "Access token is invalid", required: none, optional: none },
  access_token_expired: { status: 401, message: "Access token has expired", required: none, optional: none },
  session_revoked: { status: 401, message: "Session has been revoked", required: none, optional: none },
  invalid_credentials: { status: 401, message: "Invalid login or password", required: none, optional: none },
  invalid_recovery_code: {
    status: 401,
    message: "Invalid login or recovery code",
    required: none,
    optional: none,
  },
  invalid_refresh_token: { status: 401, message: "Refresh token is invalid", required: none, optional: none },
  refresh_token_reused: {
    status: 401,
    message: "Refresh token has already been used",
    required: none,
    optional: none,
  },
  device_mismatch: {
    status: 401,
    message: "Refresh token belongs to another device",
    required: none,
    optional: none,
  },
  // 403
  registration_closed: { status: 403, message: "Registration is closed", required: none, optional: none },
  pow_required: { status: 403, message: "Proof of work required", required: none, optional: none },
  pow_invalid: { status: 403, message: "Proof of work is invalid", required: none, optional: none },
  invalid_password: { status: 403, message: "Invalid password", required: none, optional: none },
  recent_device_restricted: {
    status: 403,
    message: "Password required on a recently added device",
    required: none,
    optional: none,
  },
  link_denied: { status: 403, message: "Device link was denied", required: none, optional: none },
  // 404
  not_found: { status: 404, message: "Not found", required: none, optional: none },
  device_not_found: { status: 404, message: "Device not found", required: none, optional: none },
  link_not_found: { status: 404, message: "Device link not found", required: none, optional: none },
  // 409
  login_taken: { status: 409, message: "Login is taken", required: none, optional: none },
  device_limit_reached: {
    status: 409,
    message: "Device limit reached",
    required: ["deviceLimit", "deviceCount"],
    optional: none,
  },
  cannot_revoke_current_device: {
    status: 409,
    message: "Cannot revoke the current device",
    required: none,
    optional: none,
  },
  link_already_claimed: { status: 409, message: "Device link is already claimed", required: none, optional: none },
  link_wrong_mode: { status: 409, message: "Device link has another mode", required: none, optional: none },
  link_not_claimed: { status: 409, message: "Device link is not claimed yet", required: none, optional: none },
  link_verify_mismatch: {
    status: 409,
    message: "Verification number does not match",
    required: none,
    optional: none,
  },
  recovery_code_outdated: { status: 409, message: "Recovery code has changed", required: none, optional: none },
  protocol_unsupported: {
    status: 409,
    message: "Sync protocol is not supported",
    required: ["minProtocol", "maxProtocol"],
    optional: none,
  },
  playback_queue_required: { status: 409, message: "Playback queue required", required: none, optional: none },
  // 410
  link_expired: { status: 410, message: "Device link has expired", required: none, optional: none },
  link_cancelled: { status: 410, message: "Device link was cancelled", required: none, optional: none },
  cursor_invalid: { status: 410, message: "Cursor is invalid", required: none, optional: none },
  cursor_expired: { status: 410, message: "Cursor has expired", required: ["floorCursor"], optional: none },
  // 413, 415
  payload_too_large: { status: 413, message: "Payload too large", required: none, optional: none },
  unsupported_media_type: { status: 415, message: "Unsupported media type", required: none, optional: none },
  // 429
  rate_limited: { status: 429, message: "Too many requests", required: ["retryAfterSeconds"], optional: none },
  login_throttled: {
    status: 429,
    message: "Too many failed login attempts",
    required: ["retryAfterSeconds"],
    optional: none,
  },
  reauth_throttled: {
    status: 429,
    message: "Too many failed password checks",
    required: ["retryAfterSeconds"],
    optional: none,
  },
  // 5xx
  internal_error: { status: 500, message: "Internal server error", required: none, optional: none },
  not_implemented: { status: 501, message: "Not implemented", required: none, optional: none },
  server_busy: { status: 503, message: "Server is busy", required: ["retryAfterSeconds"], optional: none },
  unavailable: { status: 503, message: "Service unavailable", required: none, optional: ["retryAfterSeconds"] },
  storage_full: { status: 503, message: "Server storage is full", required: ["retryAfterSeconds"], optional: none },
} as const satisfies Record<string, ErrorCodeSpec>;

export type ErrorCode = keyof typeof ERROR_CODES;

export const ALL_ERROR_CODES: readonly ErrorCode[] = Object.freeze(Object.keys(ERROR_CODES) as ErrorCode[]);

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && Object.hasOwn(ERROR_CODES, value);
}

export function errorSpec(code: ErrorCode): ErrorCodeSpec {
  return ERROR_CODES[code];
}

type RequiredDetailKeys<C extends ErrorCode> = (typeof ERROR_CODES)[C]["required"][number];
type OptionalDetailKeys<C extends ErrorCode> = (typeof ERROR_CODES)[C]["optional"][number];

/** The details a code carries: its required keys, plus its optional keys. */
export type ErrorDetailsFor<C extends ErrorCode> = { [K in RequiredDetailKeys<C>]: ErrorDetailValues[K] } & {
  [K in OptionalDetailKeys<C>]?: ErrorDetailValues[K];
};

/** Codes that need details (the `details` option of `AppError` is mandatory for them). */
export type CodeWithRequiredDetails = {
  [C in ErrorCode]: [RequiredDetailKeys<C>] extends [never] ? never : C;
}[ErrorCode];

// ---------------------------------------------------------------------------------------------------------------------
// Op result codes (API §2.3): `OpResult.code` inside a 200 response of `POST /sync`, never an HTTP error.
// ---------------------------------------------------------------------------------------------------------------------

export type OpResultStatus = "rejected" | "deferred";

export const OP_RESULT_CODES = {
  playlist_deleted: { status: "rejected" },
  invalid_video_id: { status: "rejected" },
  unknown_kind: { status: "deferred" },
  invalid_payload: { status: "deferred" },
  quota_exceeded: { status: "deferred" },
  playlist_not_found: { status: "deferred" },
  /** Comes with `retryAfterSeconds`; the client keeps the op pending. */
  op_rate_limited: { status: "deferred" },
} as const satisfies Record<string, Readonly<{ status: OpResultStatus }>>;

export type OpResultCode = keyof typeof OP_RESULT_CODES;

/** Codes clients set locally (DESIGN §3.9); the server never sends them. */
export const CLIENT_LOCAL_OP_CODES = Object.freeze(["client_bug", "server_error"] as const);
