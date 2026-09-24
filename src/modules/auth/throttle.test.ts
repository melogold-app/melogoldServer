/** Throttle policies of API §5 / DESIGN §4.1 as pure functions; the database side is `throttle.int.test.ts`. */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MINUTE_MS, SECOND_MS } from "../../lib/clock.ts";
import { LOGIN_THROTTLE, REAUTH_THROTTLE, retryAfterSeconds, throttleKeyHash, throttledError } from "./throttle.ts";

describe("throttle policies", () => {
  test("login: 5 free failures, then min(30 s · 2^(n−6), 15 min)", () => {
    const locks = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 40].map((n) => LOGIN_THROTTLE.lockMs(n));
    assert.deepEqual(locks, [
      0,
      0,
      0,
      0,
      0,
      30 * SECOND_MS,
      60 * SECOND_MS,
      120 * SECOND_MS,
      240 * SECOND_MS,
      480 * SECOND_MS,
      15 * MINUTE_MS,
      15 * MINUTE_MS,
      15 * MINUTE_MS,
    ]);
    assert.equal(LOGIN_THROTTLE.windowMs, 15 * MINUTE_MS);
  });

  test("reauth: 5 failures → 15 minutes", () => {
    assert.deepEqual(
      [1, 4, 5, 6].map((n) => REAUTH_THROTTLE.lockMs(n)),
      [0, 0, 15 * MINUTE_MS, 15 * MINUTE_MS],
    );
  });

  test("the row key is sha256(scope:key), never the key itself", () => {
    const hash = throttleKeyHash("login", "maxim");
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.notEqual(hash, throttleKeyHash("reauth", "maxim"));
  });

  test("retryAfterSeconds rounds up and is at least 1; the refusal code follows the scope", () => {
    assert.equal(retryAfterSeconds(30_000, 0), 30);
    assert.equal(retryAfterSeconds(29_001, 0), 30);
    assert.equal(retryAfterSeconds(10, 0), 1);
    const login = throttledError(LOGIN_THROTTLE, 30_000, 0);
    assert.equal(login.code, "login_throttled");
    assert.deepEqual({ ...login.details }, { retryAfterSeconds: 30 });
    assert.equal(throttledError(REAUTH_THROTTLE, 900_000, 0).code, "reauth_throttled");
  });
});
