/**
 * Small crypto helpers over `node:crypto`: SHA-256, HMAC-SHA256, constant-time comparison, random tokens and strict
 * base64url. Hashes stored in the database are lowercase hex (`ID` columns: `token_hash`, `code_hash`, …).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type BinaryLike = string | Uint8Array;

/** SHA-256 digest; strings are hashed as UTF-8. */
export function sha256(data: BinaryLike): Buffer {
  return createHash("sha256").update(data).digest();
}

/** Lowercase hex SHA-256 (64 characters); strings are hashed as UTF-8. */
export function sha256Hex(data: BinaryLike): string {
  return createHash("sha256").update(data).digest("hex");
}

/** HMAC-SHA256; strings are UTF-8. */
export function hmacSha256(key: BinaryLike, data: BinaryLike): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/**
 * Compares two strings in time that does not depend on where they differ. Strings of different length compare
 * unequal (the length itself is not secret for fixed-format tokens and hashes).
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    // Spend comparable time anyway.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

const BASE64URL = /^[A-Za-z0-9_-]*$/;

export function base64UrlEncode(data: BinaryLike): string {
  return Buffer.from(typeof data === "string" ? Buffer.from(data, "utf8") : data).toString("base64url");
}

/**
 * Strict base64url decoding (RFC 4648 §5, no padding): only the URL-safe alphabet, and only the canonical encoding
 * (unused trailing bits must be zero), so one byte string has exactly one textual form.
 * @returns the bytes, or `null` for anything that is not canonical unpadded base64url.
 */
export function base64UrlDecode(text: string): Buffer | null {
  if (!BASE64URL.test(text) || text.length % 4 === 1) return null;
  const bytes = Buffer.from(text, "base64url");
  return bytes.toString("base64url") === text ? bytes : null;
}

/** `bytes` random bytes as unpadded base64url: 32 bytes → 43 characters (API §1.6 `LinkToken`). */
export function randomBase64Url(bytes: number): string {
  if (!Number.isInteger(bytes) || bytes <= 0) throw new RangeError(`bytes must be a positive integer, got ${bytes}`);
  return randomBytes(bytes).toString("base64url");
}
