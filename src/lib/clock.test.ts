import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DAY_MS, HOUR_MS, MINUTE_MS, ManualClock, SECOND_MS, systemClock } from "./clock.ts";

describe("clock", () => {
  test("systemClock follows Date.now", () => {
    const before = Date.now();
    const now = systemClock.now();
    assert.ok(now >= before && now <= Date.now());
    assert.ok(Number.isSafeInteger(now));
  });

  test("ManualClock moves only when told to", () => {
    const clock = new ManualClock(1_700_000_000_000);
    assert.equal(clock.now(), 1_700_000_000_000);
    assert.equal(clock.advance(5 * MINUTE_MS), 1_700_000_300_000);
    assert.equal(clock.now(), 1_700_000_300_000);
    clock.set(1_000);
    assert.equal(clock.now(), 1_000);
    assert.equal(clock.advance(-500), 500);
  });

  test("ManualClock rejects non-integer times", () => {
    assert.throws(() => new ManualClock(1.5), RangeError);
    const clock = new ManualClock(0);
    assert.throws(() => {
      clock.set(Number.NaN);
    }, RangeError);
    assert.throws(() => clock.advance(Number.MAX_SAFE_INTEGER + 10), RangeError);
    assert.equal(clock.now(), 0);
  });

  test("unit constants", () => {
    assert.equal(SECOND_MS, 1000);
    assert.equal(MINUTE_MS, 60_000);
    assert.equal(HOUR_MS, 3_600_000);
    assert.equal(DAY_MS, 86_400_000);
  });
});
