/**
 * `cursor.ts` (DESIGN §3.6 "Курсор и потоки", "Разбор курсора"; PLAN T2.1 Приёмка "cursor.test: разбор, 400/410").
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isAppError } from "../../http/errors.ts";
import { atHead, baseSeq, decodeCursor, formatCursor, headCursor, parseCursor, START_POSITION } from "./cursor.ts";

const HEAD = Object.freeze({ epoch: "a1b2c3d4", seq: 4800, floorSeq: 0 });

function throwsError(fn: () => unknown, code: string, details?: Record<string, unknown>): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(isAppError(error), String(error));
    assert.equal(error.code, code);
    if (details) assert.deepEqual(error.details, details);
    return true;
  });
}

describe("decodeCursor", () => {
  test('"" is "start"', () => {
    assert.equal(decodeCursor(""), "start");
  });

  test("a well-formed cursor splits into its parts", () => {
    assert.deepEqual(decodeCursor("a1b2c3d4.4800.4790"), { epoch: "a1b2c3d4", lib: 4800, hist: 4790 });
    assert.deepEqual(decodeCursor("00000000.0.0"), { epoch: "00000000", lib: 0, hist: 0 });
  });

  test("anything else is null", () => {
    for (const text of [
      "a1b2c3d4.4800", // missing a part
      "a1b2c3d4.4800.4790.1", // extra part
      "A1B2C3D4.4800.4790", // uppercase epoch
      "a1b2c3d.4800.4790", // 7-hex epoch
      "a1b2c3d4..4790", // empty part
      "a1b2c3d4.-1.4790", // negative
      "a1b2c3d4.48 00.4790", // whitespace
      " a1b2c3d4.4800.4790", // leading space
      "a1b2c3d4.4800.4790\n", // trailing newline
    ]) {
      assert.equal(decodeCursor(text), null, text);
    }
  });

  test("a 16-digit part may lose precision as a Number but still decodes", () => {
    const decoded = decodeCursor("a1b2c3d4.9999999999999999.0");
    assert.ok(decoded !== "start" && decoded !== null && decoded.epoch === "a1b2c3d4");
  });
});

describe("formatCursor / headCursor", () => {
  test("formats the three parts", () => {
    assert.equal(formatCursor("a1b2c3d4", 4800, 4790), "a1b2c3d4.4800.4790");
  });

  test("headCursor reads both streams up to head.seq", () => {
    assert.equal(headCursor(HEAD), "a1b2c3d4.4800.4800");
  });
});

describe("parseCursor (DESIGN §3.6 «Разбор курсора»)", () => {
  test('"" is both streams from zero', () => {
    assert.deepEqual(parseCursor("", HEAD), START_POSITION);
    assert.deepEqual(parseCursor("", HEAD), { lib: 0, hist: 0 });
  });

  test("a cursor at or below the head parses to its parts", () => {
    assert.deepEqual(parseCursor("a1b2c3d4.4800.4790", HEAD), { lib: 4800, hist: 4790 });
    assert.deepEqual(parseCursor(headCursor(HEAD), HEAD), { lib: 4800, hist: 4800 });
  });

  test("not the cursor format → 400 invalid_request with the field path", () => {
    throwsError(() => parseCursor("not-a-cursor", HEAD), "invalid_request", {
      issues: [{ path: "cursor", code: "invalid_format" }],
    });
    throwsError(() => parseCursor("A1B2C3D4.1.1", HEAD), "invalid_request", {
      issues: [{ path: "cursor", code: "invalid_format" }],
    });
  });

  test("another epoch → 410 cursor_invalid", () => {
    throwsError(() => parseCursor("ffffffff.100.100", HEAD), "cursor_invalid");
  });

  test("a part beyond head.seq → 410 cursor_invalid, for either stream", () => {
    throwsError(() => parseCursor("a1b2c3d4.4801.100", HEAD), "cursor_invalid");
    throwsError(() => parseCursor("a1b2c3d4.100.4801", HEAD), "cursor_invalid");
  });

  test("a part exactly at head.seq is fine (not beyond it)", () => {
    assert.deepEqual(parseCursor("a1b2c3d4.4800.100", HEAD), { lib: 4800, hist: 100 });
  });

  test("a part below floor_seq → 410 cursor_expired {floorCursor}", () => {
    const head = { ...HEAD, floorSeq: 200 };
    throwsError(() => parseCursor("a1b2c3d4.100.300", head), "cursor_expired", {
      floorCursor: "a1b2c3d4.200.200",
    });
    throwsError(() => parseCursor("a1b2c3d4.300.100", head), "cursor_expired", {
      floorCursor: "a1b2c3d4.200.200",
    });
  });

  test("both parts exactly at floor_seq are fine (not below it)", () => {
    const head = { ...HEAD, floorSeq: 200 };
    assert.deepEqual(parseCursor("a1b2c3d4.200.200", head), { lib: 200, hist: 200 });
  });

  test("cursor_invalid is checked before cursor_expired (beyond the head wins)", () => {
    const head = { ...HEAD, floorSeq: 200 };
    throwsError(() => parseCursor("a1b2c3d4.4801.100", head), "cursor_invalid");
  });
});

describe("baseSeq (DESIGN §3.4 base, never throws)", () => {
  test("absent → null (no causal information)", () => {
    assert.equal(baseSeq(undefined, HEAD), null);
  });

  test('"" → 0 (the client had seen nothing)', () => {
    assert.equal(baseSeq("", HEAD), 0);
  });

  test("not the cursor format → null, not an error", () => {
    assert.equal(baseSeq("garbage", HEAD), null);
  });

  test("another epoch → null", () => {
    assert.equal(baseSeq("ffffffff.100.100", HEAD), null);
  });

  test("beyond the head → null", () => {
    assert.equal(baseSeq("a1b2c3d4.4801.0", HEAD), null);
  });

  test("at or below the head → its libSeq (histSeq is irrelevant)", () => {
    assert.equal(baseSeq("a1b2c3d4.4800.0", HEAD), 4800);
    assert.equal(baseSeq("a1b2c3d4.100.999999", HEAD), 100);
  });

  test("floor_seq does not matter for base (unlike parseCursor)", () => {
    const head = { epoch: "a1b2c3d4", seq: 4800 };
    assert.equal(baseSeq("a1b2c3d4.0.0", head), 0);
  });
});

describe("atHead", () => {
  test("every requested stream at the head → true", () => {
    assert.equal(atHead({ lib: 100, hist: 50 }, 100, ["library"]), true);
    assert.equal(atHead({ lib: 100, hist: 50 }, 50, ["history"]), true);
    assert.equal(atHead({ lib: 100, hist: 100 }, 100, ["library", "history"]), true);
  });

  test("a requested stream behind the head → false", () => {
    assert.equal(atHead({ lib: 99, hist: 50 }, 100, ["library"]), false);
    assert.equal(atHead({ lib: 100, hist: 50 }, 100, ["library", "history"]), false);
  });

  test("a stream not requested never blocks «at head»", () => {
    assert.equal(atHead({ lib: 0, hist: 100 }, 100, ["history"]), true);
  });
});
