import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DEVICE_NAME_MAX_LENGTH,
  cleanDeviceName,
  isValidDeviceName,
  sanitizeString,
  truncateUtf16,
  utf16Length,
  utf16LengthBetween,
  utf8ByteLength,
} from "./strings.ts";

const EMOJI = "😀"; // U+1F600: two UTF-16 units, one code point, four UTF-8 bytes

describe("lengths (API §1.4)", () => {
  test("UTF-16 units, not code points", () => {
    assert.equal(utf16Length(EMOJI), 2);
    assert.equal(utf16Length("é"), 1);
    assert.equal(utf16Length("é"), 2);
    // 63 ASCII + one emoji = 65 units: over a limit of 64 (zod .max(64) would accept it, it counts 64 code points).
    const value = "a".repeat(63) + EMOJI;
    assert.equal(utf16LengthBetween(value, 1, 64), false);
    assert.equal(utf16LengthBetween(value, 1, 65), true);
    assert.equal(utf16LengthBetween("", 1, 64), false);
  });

  test("UTF-8 bytes", () => {
    assert.equal(utf8ByteLength("abc"), 3);
    assert.equal(utf8ByteLength("ж"), 2);
    assert.equal(utf8ByteLength(EMOJI), 4);
    assert.equal(utf8ByteLength("€"), 3);
  });
});

describe("truncateUtf16", () => {
  test("never splits a surrogate pair", () => {
    assert.equal(truncateUtf16("abc", 5), "abc");
    assert.equal(truncateUtf16("abcdef", 3), "abc");
    assert.equal(truncateUtf16(`ab${EMOJI}`, 3), "ab");
    assert.equal(truncateUtf16(`ab${EMOJI}`, 4), `ab${EMOJI}`);
    assert.equal(truncateUtf16(`${EMOJI}${EMOJI}`, 3), EMOJI);
    assert.equal(truncateUtf16(EMOJI, 1), "");
    assert.equal(truncateUtf16("abc", 0), "");
    assert.throws(() => truncateUtf16("abc", -1), RangeError);
  });

  test("the result is always well-formed and within the limit", () => {
    const text = `a${EMOJI}b${EMOJI}${EMOJI}c`;
    for (let max = 0; max <= text.length + 1; max++) {
      const cut = truncateUtf16(text, max);
      assert.ok(cut.length <= max);
      assert.ok(cut.isWellFormed(), `max ${max}`);
      assert.ok(text.startsWith(cut));
    }
  });
});

describe("sanitizeString (API §1.4)", () => {
  test("removes NUL", () => {
    assert.equal(sanitizeString("a\u0000b\u0000"), "ab");
    assert.equal(sanitizeString("\u0000"), "");
  });

  test("replaces lone surrogates with U+FFFD, keeps pairs", () => {
    assert.equal(sanitizeString("a\ud800b"), "a�b");
    assert.equal(sanitizeString("a\udc00"), "a�");
    assert.equal(sanitizeString("\udc00\ud800"), "��");
    assert.equal(sanitizeString(EMOJI), EMOJI);
  });

  test("NUL first: a pair split by NUL becomes a pair", () => {
    assert.equal(sanitizeString("\ud83d\u0000\ude00"), EMOJI);
  });

  test("returns the same string when clean", () => {
    const clean = "Привет, мир";
    assert.equal(sanitizeString(clean), clean);
  });
});

describe("cleanDeviceName (API §1.6 DeviceName)", () => {
  test("removes controls and bidi marks, collapses whitespace, trims", () => {
    assert.equal(cleanDeviceName("  Google   Pixel 8  "), "Google Pixel 8");
    assert.equal(cleanDeviceName("Mac\u0000Book\u0007"), "MacBook");
    assert.equal(cleanDeviceName("a\u0085b\u009fc\u007fd"), "abcd");
    assert.equal(cleanDeviceName("‮evil‬ name‏"), "evil name");
    assert.equal(cleanDeviceName("⁦x⁩‎"), "x");
    assert.equal(cleanDeviceName("a 　b"), "a b");
    assert.equal(cleanDeviceName("\t\n"), "");
  });

  test("1..64 UTF-16 units after cleaning", () => {
    assert.equal(isValidDeviceName(""), false);
    assert.equal(isValidDeviceName("x"), true);
    assert.equal(isValidDeviceName("x".repeat(DEVICE_NAME_MAX_LENGTH)), true);
    assert.equal(isValidDeviceName("x".repeat(63) + EMOJI), false);
  });
});
