/**
 * Token formats (API §1.6, §1.7, §8; DESIGN §4.3, §4.4, §4.10.2). Keys are the HKDF subkeys of `secret-key.ts`.
 *
 * | Token        | Format                                                     | Key                     |
 * | ------------ | ---------------------------------------------------------- | ----------------------- |
 * | access       | JWT HS256 `{sub, did, av, rid, iat, exp}`                   | `jwtAccess`             |
 * | refresh      | `mgrt1.<b64url(JSON{typ,tid,sub,did,exp})>.<b64url(HMAC)>` | `refreshToken`          |
 * | PoW challenge| `mgpow1.<b64url(JSON)>.<b64url(HMAC)>` (auth module)        | `pow`                   |
 * | poll secret  | `mgps_` + 43 base64url characters (random)                 | stored as SHA-256       |
 * | link token   | 43 base64url characters (random)                           | stored as SHA-256       |
 *
 * Signed compact tokens ({@link signCompact}) carry `HMAC-SHA256(key, "<prefix>.<payload segment>")`. They are
 * deterministic: the same payload always gives the same string, so a refresh token can be re-signed from its database
 * row (DESIGN §4.4, §4.10.6), and the database stores only `sha256(token)` ({@link hashToken}).
 */
import {
  base64UrlDecode,
  base64UrlEncode,
  constantTimeEqual,
  hmacSha256,
  randomBase64Url,
  sha256Hex,
} from "./crypto.ts";
import { UUID_PATTERN } from "./ids.ts";

export const REFRESH_TOKEN_PREFIX = "mgrt1";
export const POLL_SECRET_PREFIX = "mgps_";
export const POW_CHALLENGE_PREFIX = "mgpow1";

/** API §1.6 `RefreshToken`: up to 1024 characters. */
export const REFRESH_TOKEN_MAX_LENGTH = 1024;
/** API §1.6 `PowChallenge`: up to 256 characters. */
export const POW_CHALLENGE_MAX_LENGTH = 256;
/** Access tokens are ~300 characters; anything far longer is not ours. */
export const ACCESS_TOKEN_MAX_LENGTH = 2048;

export const LINK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const POLL_SECRET_PATTERN = /^mgps_[A-Za-z0-9_-]{43}$/;

const INT32_MAX = 2_147_483_647;
const SEGMENT = /^[A-Za-z0-9_-]+$/;
/** base64url of a 32-byte HMAC-SHA256. */
const SIGNATURE_LENGTH = 43;

/** SHA-256 hex of a token or secret: what `token_hash`, `poll_secret_hash`, … store. */
export function hashToken(token: string): string {
  return sha256Hex(token);
}

// ---------------------------------------------------------------------------------------------------------------------
// Signed compact tokens
// ---------------------------------------------------------------------------------------------------------------------

function compactSignature(prefix: string, payloadSegment: string, key: Uint8Array): string {
  return base64UrlEncode(hmacSha256(key, `${prefix}.${payloadSegment}`));
}

/** `<prefix>.<b64url(JSON(payload))>.<b64url(HMAC-SHA256(key, "<prefix>.<payload segment>"))>`. */
export function signCompact(prefix: string, payload: object, key: Uint8Array): string {
  const payloadSegment = base64UrlEncode(JSON.stringify(payload));
  return `${prefix}.${payloadSegment}.${compactSignature(prefix, payloadSegment, key)}`;
}

/**
 * Verifies a token of {@link signCompact} and returns its parsed JSON payload.
 * @returns the payload, or `null` when the prefix, shape, length or signature is wrong, or the payload is not JSON.
 */
export function openCompact(prefix: string, token: string, key: Uint8Array, maxLength: number): unknown {
  if (token.length > maxLength) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [head, payloadSegment, signature] = parts as [string, string, string];
  if (head !== prefix || !SEGMENT.test(payloadSegment) || signature.length !== SIGNATURE_LENGTH) return null;
  if (!constantTimeEqual(signature, compactSignature(prefix, payloadSegment, key))) return null;
  return parseJsonSegment(payloadSegment);
}

function parseJsonSegment(segment: string): unknown {
  const bytes = base64UrlDecode(segment);
  if (bytes === null) return null;
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isUuidString(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------------------------------------------------
// Refresh token (DESIGN §4.4)
// ---------------------------------------------------------------------------------------------------------------------

export type RefreshTokenPayload = Readonly<{
  typ: "refresh";
  /** `refresh_tokens.id`. */
  tid: string;
  /** User id. */
  sub: string;
  /** Device id. */
  did: string;
  /** Expiry, epoch **seconds** (`floor(refresh_tokens.expires_at / 1000)`). */
  exp: number;
}>;

export type RefreshTokenInput = Readonly<{
  tid: string;
  sub: string;
  did: string;
  /** `refresh_tokens.expires_at`, epoch milliseconds. */
  expiresAt: number;
}>;

/** Signs the refresh token of a `refresh_tokens` row. The same row always gives the same string. */
export function signRefreshToken(input: RefreshTokenInput, key: Uint8Array): string {
  const payload: RefreshTokenPayload = {
    typ: "refresh",
    tid: input.tid,
    sub: input.sub,
    did: input.did,
    exp: Math.floor(input.expiresAt / 1000),
  };
  return signCompact(REFRESH_TOKEN_PREFIX, payload, key);
}

/**
 * Checks the HMAC and the payload shape of a refresh token. The expiry is **not** checked here: logout and the `rt`
 * rate-limit key accept an expired but authentic token (API §1.10, DESIGN §4.5); refresh checks
 * {@link isRefreshTokenExpired} itself.
 * @returns the payload, or `null` when the token is not an authentic `mgrt1` token.
 */
export function parseRefreshToken(token: string, key: Uint8Array): RefreshTokenPayload | null {
  const payload = openCompact(REFRESH_TOKEN_PREFIX, token, key, REFRESH_TOKEN_MAX_LENGTH);
  if (!isRecord(payload)) return null;
  const { typ, tid, sub, did, exp } = payload;
  if (typ !== "refresh" || !isUuidString(tid) || !isUuidString(sub) || !isUuidString(did)) return null;
  if (!isPositiveSafeInteger(exp)) return null;
  return Object.freeze({ typ, tid, sub, did, exp });
}

export function isRefreshTokenExpired(payload: RefreshTokenPayload, now: number): boolean {
  return payload.exp * 1000 <= now;
}

/** The columns a refresh token is compared with (`matches(p, row)` of DESIGN §4.4). */
export type RefreshTokenRowKey = Readonly<{ id: string; user_id: string; device_id: string; expires_at: number }>;

/** Whether an authentic token describes this row (id, user, device and expiry second). */
export function refreshTokenMatchesRow(payload: RefreshTokenPayload, row: RefreshTokenRowKey): boolean {
  return (
    payload.tid === row.id &&
    payload.sub === row.user_id &&
    payload.did === row.device_id &&
    payload.exp === Math.floor(row.expires_at / 1000)
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Access token: JWT HS256 (API §1.7, DESIGN §4.3)
// ---------------------------------------------------------------------------------------------------------------------

/** The only header this server issues and accepts; `alg` other than HS256 (including `none`) is rejected. */
const JWT_HEADER_SEGMENT = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));

export type AccessTokenClaims = Readonly<{
  /** User id. */
  sub: string;
  /** Device id. */
  did: string;
  /** `users.auth_version` when the token was issued. */
  av: number;
  /** `refresh_tokens.id` issued together with this access token. */
  rid: string;
  /** Issued at, epoch seconds. */
  iat: number;
  /** Expires at, epoch seconds. */
  exp: number;
}>;

export type AccessTokenSubject = Readonly<{ sub: string; did: string; av: number; rid: string }>;

export type SignedAccessToken = Readonly<{
  token: string;
  claims: AccessTokenClaims;
  /** `exp` in epoch milliseconds (`accessTokenExpiresAt`). */
  expiresAt: number;
}>;

/**
 * Issues an access token valid for `ttlSeconds` from `now` (rounded down to the second, like `iat`).
 * @param now epoch milliseconds.
 */
export function signAccessToken(
  subject: AccessTokenSubject,
  key: Uint8Array,
  options: Readonly<{ now: number; ttlSeconds: number }>,
): SignedAccessToken {
  if (!Number.isSafeInteger(options.ttlSeconds) || options.ttlSeconds <= 0) {
    throw new RangeError(`ttlSeconds must be a positive integer, got ${options.ttlSeconds}`);
  }
  const iat = Math.floor(options.now / 1000);
  const claims: AccessTokenClaims = {
    sub: subject.sub,
    did: subject.did,
    av: subject.av,
    rid: subject.rid,
    iat,
    exp: iat + options.ttlSeconds,
  };
  const payloadSegment = base64UrlEncode(JSON.stringify(claims));
  const signingInput = `${JWT_HEADER_SEGMENT}.${payloadSegment}`;
  const token = `${signingInput}.${base64UrlEncode(hmacSha256(key, signingInput))}`;
  return Object.freeze({ token, claims: Object.freeze(claims), expiresAt: claims.exp * 1000 });
}

export type AccessTokenVerification =
  Readonly<{ ok: true; claims: AccessTokenClaims }> | Readonly<{ ok: false; reason: "invalid" | "expired" }>;

/**
 * Verifies an access token: shape, header, signature, claims, then expiry. A forged or malformed token is always
 * `invalid`, never `expired` (the signature is checked before the claims are trusted).
 * @param now epoch milliseconds.
 */
export function verifyAccessToken(token: string, key: Uint8Array, now: number): AccessTokenVerification {
  const invalid = { ok: false, reason: "invalid" } as const;
  if (token.length > ACCESS_TOKEN_MAX_LENGTH) return invalid;
  const parts = token.split(".");
  if (parts.length !== 3) return invalid;
  const [header, payloadSegment, signature] = parts as [string, string, string];
  if (header !== JWT_HEADER_SEGMENT || !SEGMENT.test(payloadSegment) || signature.length !== SIGNATURE_LENGTH) {
    return invalid;
  }
  const expected = base64UrlEncode(hmacSha256(key, `${header}.${payloadSegment}`));
  if (!constantTimeEqual(signature, expected)) return invalid;

  const payload = parseJsonSegment(payloadSegment);
  if (!isRecord(payload)) return invalid;
  const { sub, did, av, rid, iat, exp } = payload;
  if (!isUuidString(sub) || !isUuidString(did) || !isUuidString(rid)) return invalid;
  if (!isPositiveSafeInteger(av) || av > INT32_MAX) return invalid;
  if (!isPositiveSafeInteger(iat) || !isPositiveSafeInteger(exp) || exp <= iat) return invalid;
  if (exp * 1000 <= now) return { ok: false, reason: "expired" };
  return { ok: true, claims: Object.freeze({ sub, did, av, rid, iat, exp }) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Random secrets (DESIGN §4.10.2)
// ---------------------------------------------------------------------------------------------------------------------

/** `mgps_` + 32 random bytes (43 base64url characters). Only the new device knows it; stored as SHA-256. */
export function newPollSecret(): string {
  return `${POLL_SECRET_PREFIX}${randomBase64Url(32)}`;
}

/** 32 random bytes, 43 base64url characters (the QR `linkToken`); stored as SHA-256. */
export function newLinkToken(): string {
  return randomBase64Url(32);
}
