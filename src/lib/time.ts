/**
 * Time on the wire (API §1.5).
 *
 * - The server **sends** `YYYY-MM-DDTHH:mm:ss.sssZ` only ({@link formatIso}).
 * - The server **accepts** `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$` ({@link parseIso}): the fraction is
 *   truncated to milliseconds, so JVM `Instant.toString()` and C# `"o"` work as they are; offsets other than `Z` are
 *   rejected; the value must be a real calendar instant in [2000-01-01, 2100-01-01).
 * - The database stores epoch milliseconds UTC.
 */

export const ISO_INPUT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

/** 2000-01-01T00:00:00.000Z: the first accepted instant. */
export const MIN_ISO_TIME_MS = Date.UTC(2000, 0, 1);
/** 2100-01-01T00:00:00.000Z: the first rejected instant (the range is half-open). */
export const MAX_ISO_TIME_MS = Date.UTC(2100, 0, 1);

/**
 * Parses an input timestamp of API §1.5.
 * @returns epoch milliseconds, or `null` when the text is not an accepted timestamp (wrong format, impossible date
 *   such as February 30 or 24:00, leap second, out of range).
 */
export function parseIso(text: string): number | null {
  const match = ISO_INPUT_PATTERN.exec(text);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, fraction] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const millis = fraction === undefined ? 0 : Number(fraction.slice(0, 3).padEnd(3, "0"));
  const time = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  // Date.UTC rolls impossible days over (Feb 30 → Mar 2): reject when the day moved.
  if (new Date(time).getUTCDate() !== day) return null;
  if (time < MIN_ISO_TIME_MS || time >= MAX_ISO_TIME_MS) return null;
  return time;
}

/** Whether {@link parseIso} accepts the text. */
export function isIso(text: string): boolean {
  return parseIso(text) !== null;
}

/**
 * Formats epoch milliseconds as `YYYY-MM-DDTHH:mm:ss.sssZ` (API §1.5).
 * @throws RangeError for a non-integer or a time outside years 0000–9999.
 */
export function formatIso(time: number): string {
  if (!Number.isSafeInteger(time)) throw new RangeError(`time must be integer epoch milliseconds, got ${time}`);
  const text = new Date(time).toISOString();
  if (text.length !== 24) throw new RangeError(`time ${time} is outside years 0000–9999`);
  return text;
}

/** {@link formatIso} for nullable columns: `null` stays `null` (API §1.3: absent values are `null`). */
export function formatIsoOrNull(time: number | null): string | null {
  return time === null ? null : formatIso(time);
}
