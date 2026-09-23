import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MAX_ISO_TIME_MS, MIN_ISO_TIME_MS, formatIso, formatIsoOrNull, isIso, parseIso } from "./time.ts";

const T = Date.UTC(2026, 8, 23, 10, 0, 0, 123);

describe("parseIso (API §1.5)", () => {
  test("accepts 0 to 9 fraction digits and truncates to milliseconds", () => {
    assert.equal(parseIso("2026-09-23T10:00:00Z"), T - 123);
    assert.equal(parseIso("2026-09-23T10:00:00.1Z"), T - 23);
    assert.equal(parseIso("2026-09-23T10:00:00.12Z"), T - 3);
    assert.equal(parseIso("2026-09-23T10:00:00.123Z"), T);
    assert.equal(parseIso("2026-09-23T10:00:00.123456Z"), T, "JVM Instant.toString() micros");
    assert.equal(parseIso("2026-09-23T10:00:00.1234567Z"), T, 'C# "o" ticks');
    assert.equal(parseIso("2026-09-23T10:00:00.123999999Z"), T, "truncated, not rounded");
  });

  test("M0 acceptance: .123456Z is accepted and sent back as .123Z", () => {
    const parsed = parseIso("2026-09-23T10:00:00.123456Z");
    assert.ok(parsed !== null);
    assert.equal(formatIso(parsed), "2026-09-23T10:00:00.123Z");
  });

  test("rejects other shapes and offsets", () => {
    for (const text of [
      "2026-09-23T10:00:00.1234567890Z",
      "2026-09-23T10:00:00.Z",
      "2026-09-23T10:00:00+00:00",
      "2026-09-23T10:00:00.000+03:00",
      "2026-09-23T10:00:00",
      "2026-09-23 10:00:00Z",
      "2026-09-23t10:00:00z",
      "2026-9-23T10:00:00Z",
      "2026-09-23T10:00Z",
      " 2026-09-23T10:00:00Z",
      "2026-09-23T10:00:00Z\n",
      "+002026-09-23T10:00:00Z",
      "٢٠٢٦-09-23T10:00:00Z",
      "",
    ]) {
      assert.equal(parseIso(text), null, text);
      assert.equal(isIso(text), false, text);
    }
  });

  test("rejects impossible calendar values", () => {
    for (const text of [
      "2026-02-29T00:00:00Z",
      "2026-02-30T00:00:00Z",
      "2026-04-31T00:00:00Z",
      "2026-13-01T00:00:00Z",
      "2026-00-10T00:00:00Z",
      "2026-01-00T00:00:00Z",
      "2026-01-01T24:00:00Z",
      "2026-01-01T23:60:00Z",
      "2026-12-31T23:59:60Z",
    ]) {
      assert.equal(parseIso(text), null, text);
    }
    assert.equal(parseIso("2028-02-29T00:00:00Z"), Date.UTC(2028, 1, 29));
  });

  test("range [2000-01-01, 2100-01-01)", () => {
    assert.equal(parseIso("2000-01-01T00:00:00.000Z"), MIN_ISO_TIME_MS);
    assert.equal(parseIso("1999-12-31T23:59:59.999Z"), null);
    assert.equal(parseIso("2099-12-31T23:59:59.999999999Z"), MAX_ISO_TIME_MS - 1);
    assert.equal(parseIso("2100-01-01T00:00:00Z"), null);
    assert.equal(MIN_ISO_TIME_MS, 946_684_800_000);
    assert.equal(MAX_ISO_TIME_MS, 4_102_444_800_000);
  });
});

describe("formatIso", () => {
  test("always YYYY-MM-DDTHH:mm:ss.sssZ", () => {
    assert.equal(formatIso(T - 123), "2026-09-23T10:00:00.000Z");
    assert.equal(formatIso(0), "1970-01-01T00:00:00.000Z");
    assert.equal(formatIso(MAX_ISO_TIME_MS - 1), "2099-12-31T23:59:59.999Z");
    for (let i = 0; i < 50; i++) {
      const time = MIN_ISO_TIME_MS + Math.floor(Math.random() * (MAX_ISO_TIME_MS - MIN_ISO_TIME_MS));
      const text = formatIso(time);
      assert.match(text, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      assert.equal(parseIso(text), time);
    }
  });

  test("rejects non-integers and years beyond 9999", () => {
    assert.throws(() => formatIso(1.5), RangeError);
    assert.throws(() => formatIso(Number.NaN), RangeError);
    assert.throws(() => formatIso(Date.UTC(10000, 0, 1)), RangeError);
    assert.throws(() => formatIso(Date.UTC(-1, 0, 1)), RangeError);
  });

  test("formatIsoOrNull keeps null", () => {
    assert.equal(formatIsoOrNull(null), null);
    assert.equal(formatIsoOrNull(T), "2026-09-23T10:00:00.123Z");
  });
});
