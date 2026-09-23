/**
 * Strings (API §1.4, §1.6, §11).
 *
 * - Every length limit is in **UTF-16 code units** (`s.length` in JS, `String.length` in Kotlin/C#,
 *   `s.utf16.count` in Swift). zod 4.6 `.min()`/`.max()`/`.length()` count code points, so limits are checked here
 *   ({@link utf16LengthBetween}) and never with those zod methods.
 * - Request bodies are sanitized before validation ({@link sanitizeString}): `U+0000` removed, lone surrogates
 *   replaced by `U+FFFD`. PostgreSQL rejects both (22021), SQLite would store them.
 * - Truncation to a limit never splits a surrogate pair ({@link truncateUtf16}).
 */

export function utf16Length(value: string): number {
  return value.length;
}

/** `min <= value.length <= max` in UTF-16 units. */
export function utf16LengthBetween(value: string, min: number, max: number): boolean {
  return value.length >= min && value.length <= max;
}

/** Bytes of the UTF-8 encoding (the password limit of 512 bytes, API §1.6). */
export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Cuts `value` to at most `maxLength` UTF-16 units without splitting a surrogate pair: when the cut would leave a
 * lone high surrogate at the end, that unit is dropped too (the result may then be one unit shorter).
 */
export function truncateUtf16(value: string, maxLength: number): string {
  if (!Number.isInteger(maxLength) || maxLength < 0) throw new RangeError(`maxLength must be >= 0, got ${maxLength}`);
  if (value.length <= maxLength) return value;
  const end = maxLength > 0 && isHighSurrogate(value.charCodeAt(maxLength - 1)) ? maxLength - 1 : maxLength;
  return value.slice(0, end);
}

/**
 * The request string rule of API §1.4: removes every `U+0000` and replaces lone surrogates with `U+FFFD`. NUL is
 * removed first, so a pair split only by NUL becomes a valid pair again. Returns the same string when nothing changes.
 */
export function sanitizeString(value: string): string {
  const withoutNul = value.includes("\u0000") ? value.replaceAll("\u0000", "") : value;
  return withoutNul.isWellFormed() ? withoutNul : withoutNul.toWellFormed();
}

// C0, DEL and C1 controls; LRM/RLM; LRE…RLO (bidi embeddings and overrides); LRI…PDI (bidi isolates).
// eslint-disable-next-line no-control-regex -- removing control characters is the point
const DEVICE_NAME_REMOVED = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
const WHITESPACE_RUN = /\s+/g;

/** Limits of API §1.6 `DeviceName` after cleaning. */
export const DEVICE_NAME_MIN_LENGTH = 1;
export const DEVICE_NAME_MAX_LENGTH = 64;

/**
 * Cleans a device name (API §1.6 `DeviceName`): removes C0/C1 controls, U+200E/U+200F, U+202A–U+202E and
 * U+2066–U+2069, collapses whitespace runs into one space, trims. The caller then checks 1..64 UTF-16 units
 * ({@link isValidDeviceName}).
 */
export function cleanDeviceName(value: string): string {
  return value.replace(DEVICE_NAME_REMOVED, "").replace(WHITESPACE_RUN, " ").trim();
}

/** Whether an already cleaned name fits API §1.6 (1..64 UTF-16 units). */
export function isValidDeviceName(cleaned: string): boolean {
  return utf16LengthBetween(cleaned, DEVICE_NAME_MIN_LENGTH, DEVICE_NAME_MAX_LENGTH);
}
