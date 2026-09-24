/**
 * `wins.ts`, the conflict rule of every LWW register (DESIGN §3.4; PLAN T2.1 Приёмка "wins.test: таблица DESIGN
 * §3.4").
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { effectiveAt, wins } from "./wins.ts";
import type { Register } from "./wins.ts";

describe("effectiveAt (effAt = min(op.at, now))", () => {
  test("a clock in the future is clamped to now", () => {
    assert.equal(effectiveAt(2000, 1000), 1000);
  });

  test("a clock in the past (or equal) passes through", () => {
    assert.equal(effectiveAt(500, 1000), 500);
    assert.equal(effectiveAt(1000, 1000), 1000);
  });
});

describe("wins (DESIGN §3.4 conflict table)", () => {
  test("nothing stored yet → always wins", () => {
    assert.equal(wins(null, { base: null, effAt: 1, dev: "a" }), true);
    assert.equal(wins(null, { base: 0, effAt: 0, dev: "a" }), true);
  });

  test("the author had seen the current value (reg.seq <= base) → wins regardless of effAt or device", () => {
    const reg: Register = { seq: 10, at: 5000, dev: "device-b" };
    // effAt far in the past, different device: only the base rule can make this win.
    assert.equal(wins(reg, { base: 10, effAt: 1, dev: "device-a" }), true);
    assert.equal(wins(reg, { base: 11, effAt: 1, dev: "device-a" }), true);
  });

  test("base strictly below reg.seq gives no causal information (falls through to the clock rule)", () => {
    const reg: Register = { seq: 10, at: 5000, dev: "device-b" };
    assert.equal(wins(reg, { base: 9, effAt: 1, dev: "device-a" }), false);
  });

  test("base === null never wins by itself", () => {
    const reg: Register = { seq: 10, at: 5000, dev: "device-b" };
    assert.equal(wins(reg, { base: null, effAt: 1, dev: "device-a" }), false);
  });

  test("concurrent edits: the later effAt wins, whatever the device", () => {
    const reg: Register = { seq: 10, at: 5000, dev: "device-b" };
    assert.equal(wins(reg, { base: null, effAt: 5001, dev: "device-a" }), true);
    assert.equal(wins(reg, { base: null, effAt: 4999, dev: "device-a" }), false);
  });

  test("a tie (effAt === reg.at): the same device always wins (idempotent replays, retries)", () => {
    const reg: Register = { seq: 10, at: 5000, dev: "device-a" };
    assert.equal(wins(reg, { base: null, effAt: 5000, dev: "device-a" }), true);
  });

  test("a tie between different devices: the larger device id wins (ordinal string compare)", () => {
    const reg: Register = { seq: 10, at: 5000, dev: "device-a" };
    assert.equal(wins(reg, { base: null, effAt: 5000, dev: "device-b" }), true); // "device-b" > "device-a"
    assert.equal(wins(reg, { base: null, effAt: 5000, dev: "device-0" }), false); // "device-0" < "device-a"
  });

  test("a tie against a register with no device (reg.dev === null): any device id beats ''", () => {
    const reg: Register = { seq: 10, at: 5000, dev: null };
    assert.equal(wins(reg, { base: null, effAt: 5000, dev: "a" }), true);
    assert.equal(wins(reg, { base: null, effAt: 5000, dev: "" }), false); // "" is not > "", and not === null
  });

  test("device ids compare ordinally as JS strings (lowercase UUIDs, so byte order matches the clients)", () => {
    const reg: Register = { seq: 10, at: 5000, dev: "aaaaaaaa-0000-0000-0000-000000000000" };
    assert.equal(wins(reg, { base: null, effAt: 5000, dev: "bbbbbbbb-0000-0000-0000-000000000000" }), true);
    assert.equal(
      wins(reg, { base: null, effAt: 5000, dev: "aaaaaaaa-0000-0000-0000-000000000000" }),
      true, // same device: idempotent
    );
    assert.equal(wins(reg, { base: null, effAt: 5000, dev: "0000000-0000-0000-0000-000000000000" }), false);
  });

  test("DESIGN §3.16 example: offline like at 10:00, offline unlike at 11:00 (later effAt wins, not commuted)", () => {
    const likedAt10 = Date.UTC(2026, 8, 23, 10, 0, 0);
    const unlikedAt11 = Date.UTC(2026, 8, 23, 11, 0, 0);
    const reg: Register = { seq: 1, at: likedAt10, dev: "phone" };
    assert.equal(wins(reg, { base: null, effAt: unlikedAt11, dev: "laptop" }), true);
  });

  test("DESIGN §3.16 example: a device that had seen the like but whose clock is behind still wins via base", () => {
    const likedAt = Date.UTC(2026, 8, 23, 11, 0, 0);
    const reg: Register = { seq: 5, at: likedAt, dev: "laptop" };
    // The laptop's own clock is behind (effAt before reg.at), but it had pulled seq 5 already.
    assert.equal(wins(reg, { base: 5, effAt: likedAt - 60_000, dev: "laptop" }), true);
  });
});
