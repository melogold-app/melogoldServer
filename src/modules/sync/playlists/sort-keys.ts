/**
 * Order keys of playlist items (API §8, DESIGN §3.7): fractional indexing over the base62 alphabet `0-9A-Za-z`,
 * compared **ordinally** (byte by byte: digits < upper case < lower case). Only the server issues keys; clients sort
 * by `(sortKey, videoId)` and never compute a key.
 *
 * A key is `<integer part><fraction>`:
 * - the integer part starts with a head letter that gives its length: `a`..`z` → 2..27 characters (non-negative
 *   integers growing upwards), `Z`..`A` → 2..27 characters (negative integers growing downwards);
 * - the fraction is any base62 string without a trailing `0`.
 *
 * `keyBetween(null, null)` is `a0`; appending increments the integer part (`a0`, `a1`, … `az`, `b00`, …), prepending
 * decrements it (`Zz`, `Zy`, …), and a key between two neighbours takes the midpoint of their fractions, so a key
 * grows by about one character per six insertions at the same place. When a new key would be longer than
 * {@link MAX_SORT_KEY_LENGTH}, the caller reissues every key of the playlist ({@link keysBetween}`(null, null, n)`).
 *
 * The algorithm is the widely used "fractional-indexing" scheme (David Greenspan, "Implementing Fractional
 * Indexing"), written here from its description: the database column holds at most 64 characters (API §9.2).
 */

/** The base62 alphabet in ordinal order (API §8). */
export const SORT_KEY_DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** A new key longer than this triggers a rebalance of the playlist (API §8). */
export const MAX_SORT_KEY_LENGTH = 48;

const ZERO = "0";
const SMALLEST_INTEGER = `A${ZERO.repeat(26)}`;

export class SortKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SortKeyError";
  }
}

/** Ordinal comparison of two keys (or video ids): negative, zero or positive. */
export function compareOrdinal(a: string, b: string): number {
  // JavaScript compares strings by UTF-16 code units; keys and video ids are ASCII, so this is byte order.
  return a < b ? -1 : a > b ? 1 : 0;
}

function digitValue(char: string): number {
  const value = SORT_KEY_DIGITS.indexOf(char);
  if (value < 0 || char.length !== 1) throw new SortKeyError(`not a base62 digit: "${char}"`);
  return value;
}

function digitAt(value: number): string {
  const char = SORT_KEY_DIGITS[value];
  if (char === undefined) throw new SortKeyError(`digit out of range: ${value}`);
  return char;
}

function integerLength(head: string): number {
  if (head >= "a" && head <= "z") return head.charCodeAt(0) - "a".charCodeAt(0) + 2;
  if (head >= "A" && head <= "Z") return "Z".charCodeAt(0) - head.charCodeAt(0) + 2;
  throw new SortKeyError(`invalid head of an order key: "${head}"`);
}

function integerPart(key: string): string {
  const length = integerLength(key.charAt(0));
  if (length > key.length) throw new SortKeyError(`order key too short for its head: "${key}"`);
  return key.slice(0, length);
}

/** Whether `key` is a well-formed order key (the server never stores another). */
export function isValidSortKey(key: string): boolean {
  try {
    validateKey(key);
    return true;
  } catch (error) {
    if (error instanceof SortKeyError) return false;
    throw error;
  }
}

function validateKey(key: string): void {
  if (key === SMALLEST_INTEGER) throw new SortKeyError(`invalid order key: "${key}"`);
  const integer = integerPart(key); // checks the head letter and the length of the integer part
  for (const char of key.slice(1)) digitValue(char);
  if (key.length > integer.length && key.endsWith(ZERO)) throw new SortKeyError(`trailing zero: "${key}"`);
}

/** A fraction strictly between `a` and `b` (`b === null`: no upper bound). Neither ends with `0`. */
function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new SortKeyError(`${a} >= ${b}`);
  if (a.endsWith(ZERO) || b?.endsWith(ZERO) === true) throw new SortKeyError("trailing zero");
  if (b !== null) {
    // Strip the longest common prefix, padding `a` with zeros.
    let n = 0;
    while ((a.charAt(n) || ZERO) === b.charAt(n)) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a === "" ? 0 : digitValue(a.charAt(0));
  const digitB = b === null ? SORT_KEY_DIGITS.length : digitValue(b.charAt(0));
  if (digitB - digitA > 1) return digitAt(Math.round((digitA + digitB) / 2));
  // The first digits are consecutive.
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return digitAt(digitA) + midpoint(a.slice(1), null);
}

function incrementInteger(integer: string): string | null {
  const [head = "", ...digits] = integer;
  let carry = true;
  for (let i = digits.length - 1; carry && i >= 0; i--) {
    const next = digitValue(digits[i] ?? "") + 1;
    if (next === SORT_KEY_DIGITS.length) {
      digits[i] = ZERO;
    } else {
      digits[i] = digitAt(next);
      carry = false;
    }
  }
  if (!carry) return head + digits.join("");
  if (head === "Z") return `a${ZERO}`;
  if (head === "z") return null;
  const nextHead = String.fromCharCode(head.charCodeAt(0) + 1);
  if (nextHead > "a") digits.push(ZERO);
  else digits.pop();
  return nextHead + digits.join("");
}

function decrementInteger(integer: string): string | null {
  const [head = "", ...digits] = integer;
  const largest = digitAt(SORT_KEY_DIGITS.length - 1);
  let borrow = true;
  for (let i = digits.length - 1; borrow && i >= 0; i--) {
    const next = digitValue(digits[i] ?? "") - 1;
    if (next === -1) {
      digits[i] = largest;
    } else {
      digits[i] = digitAt(next);
      borrow = false;
    }
  }
  if (!borrow) return head + digits.join("");
  if (head === "a") return `Z${largest}`;
  if (head === "A") return null;
  const nextHead = String.fromCharCode(head.charCodeAt(0) - 1);
  if (nextHead < "Z") digits.push(largest);
  else digits.pop();
  return nextHead + digits.join("");
}

/**
 * A key strictly between `a` and `b` in ordinal order; `null` is an open end.
 * @throws SortKeyError when a bound is malformed or `a >= b`.
 */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null) validateKey(a);
  if (b !== null) validateKey(b);
  if (a !== null && b !== null && a >= b) throw new SortKeyError(`${a} >= ${b}`);
  if (a === null) {
    if (b === null) return `a${ZERO}`;
    const integerB = integerPart(b);
    const fractionB = b.slice(integerB.length);
    if (integerB === SMALLEST_INTEGER) return integerB + midpoint("", fractionB);
    if (integerB < b) return integerB;
    const decremented = decrementInteger(integerB);
    if (decremented === null) throw new SortKeyError("cannot decrement any more");
    return decremented;
  }
  const integerA = integerPart(a);
  const fractionA = a.slice(integerA.length);
  if (b === null) {
    const incremented = incrementInteger(integerA);
    return incremented ?? integerA + midpoint(fractionA, null);
  }
  const integerB = integerPart(b);
  const fractionB = b.slice(integerB.length);
  if (integerA === integerB) return integerA + midpoint(fractionA, fractionB);
  const incremented = incrementInteger(integerA);
  if (incremented === null) throw new SortKeyError("cannot increment any more");
  if (incremented < b) return incremented;
  return integerA + midpoint(fractionA, null);
}

/**
 * `n` increasing keys strictly between `a` and `b` (`null`: open end). With both bounds set, the keys are spread by
 * bisection, so their length grows with `log62(n)`, not with `n`.
 * @throws SortKeyError when a bound is malformed or `a >= b`.
 */
export function keysBetween(a: string | null, b: string | null, n: number): string[] {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`key count must be a non-negative integer: ${n}`);
  if (n === 0) {
    if (a !== null) validateKey(a);
    if (b !== null) validateKey(b);
    if (a !== null && b !== null && a >= b) throw new SortKeyError(`${a} >= ${b}`);
    return [];
  }
  if (n === 1) return [keyBetween(a, b)];
  if (b === null) {
    const keys = [keyBetween(a, null)];
    for (let i = 1; i < n; i++) keys.push(keyBetween(keys[i - 1] ?? null, null));
    return keys;
  }
  if (a === null) {
    const keys = [keyBetween(null, b)];
    for (let i = 1; i < n; i++) keys.push(keyBetween(null, keys[i - 1] ?? null));
    return keys.reverse();
  }
  const middle = Math.floor(n / 2);
  const key = keyBetween(a, b);
  return [...keysBetween(a, key, middle), key, ...keysBetween(key, b, n - middle - 1)];
}

/**
 * {@link keysBetween} for the write path: `null` instead of keys when the bounds are not usable (malformed, equal or
 * out of order) or when a new key would be longer than {@link MAX_SORT_KEY_LENGTH}. The caller then rebalances.
 */
export function tryKeysBetween(a: string | null, b: string | null, n: number): string[] | null {
  let keys: string[];
  try {
    keys = keysBetween(a, b, n);
  } catch (error) {
    if (error instanceof SortKeyError) return null;
    throw error;
  }
  return keys.every((key) => key.length <= MAX_SORT_KEY_LENGTH) ? keys : null;
}
