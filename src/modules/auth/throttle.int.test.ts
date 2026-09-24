/**
 * Login throttling on the real database (`auth_throttle`, DESIGN §4.1, PLAN T1.1 acceptance `throttle.int`); the
 * pure policy table is `throttle.test.ts`. The 6th failure locks the login for 30 s; a device the account already
 * knows bypasses the lock, so an attacker who guesses a password wrong cannot lock the owner out.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { createDevice, createUser, uniqueLogin } from "../../test/factories.ts";
import { assertError, createTestApp } from "../../test/test-app.ts";
import type { TestApp } from "../../test/test-app.ts";
import { Argon2Pool } from "./argon2-pool.ts";

const FAST_ARGON2 = { ARGON2_MEMORY_KIB: "19456", ARGON2_TIME_COST: "2" };
const PASSWORD = "две собаки и кот";

function loginBody(login: string, password: string, hwid: string) {
  return { login, password, device: { hwid, name: "Google Pixel 8", platform: "android" } };
}

describe("login throttling (auth_throttle, scope login)", () => {
  let t: TestApp;
  let login: string;
  let knownHwid: string;

  before(async () => {
    t = await createTestApp({ env: FAST_ARGON2 });
    const pool = new Argon2Pool({ memoryKiB: 19_456, timeCost: 2, parallelism: 1, maxConcurrency: 2, queueLimit: 8 });
    const passwordHash = await pool.hash(PASSWORD);
    login = uniqueLogin("victim");
    const user = await createUser(t.db, { login, passwordHash });
    knownHwid = randomBytes(32).toString("hex");
    await createDevice(t.db, user.id, { hwid: knownHwid });
  });

  after(async () => {
    await t.close();
  });

  async function failFrom(hwid: string) {
    return t.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: loginBody(login, "wrong password", hwid),
    });
  }

  test("5 failures from an unfamiliar device are free; the 6th locks the login for 30 s", async () => {
    const strangerHwid = randomBytes(32).toString("hex");
    for (let i = 0; i < 5; i++) {
      const response = await failFrom(strangerHwid);
      assertError(response, 401, "invalid_credentials");
    }
    const sixth = await failFrom(strangerHwid);
    const body = assertError(sixth, 429, "login_throttled");
    assert.equal(body.retryAfterSeconds, 30);

    // The lock is by login, not by device: even a fresh, never-seen device is refused now.
    const anotherStranger = await failFrom(randomBytes(32).toString("hex"));
    assertError(anotherStranger, 429, "login_throttled");
  });

  test("a device the account already knows bypasses the lock: the correct password still logs in", async () => {
    const response = await t.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: loginBody(login, PASSWORD, knownHwid),
    });
    assert.equal(response.statusCode, 200, response.body);
  });

  test("success cleared the throttle row: failures start again at 0 for a stranger", async () => {
    const strangerHwid = randomBytes(32).toString("hex");
    for (let i = 0; i < 5; i++) {
      const response = await failFrom(strangerHwid);
      assertError(response, 401, "invalid_credentials");
    }
    // A 6th failure would lock again — proof the previous lock (and its failure count) was really cleared.
    const sixth = await failFrom(strangerHwid);
    assertError(sixth, 429, "login_throttled");
  });
});

describe("login throttling: the lock grows and expires", () => {
  let t: TestApp;
  let login: string;

  before(async () => {
    t = await createTestApp({ env: FAST_ARGON2 });
    const pool = new Argon2Pool({ memoryKiB: 19_456, timeCost: 2, parallelism: 1, maxConcurrency: 2, queueLimit: 8 });
    const passwordHash = await pool.hash(PASSWORD);
    login = uniqueLogin("victim2");
    await createUser(t.db, { login, passwordHash });
  });

  after(async () => {
    await t.close();
  });

  async function fail() {
    return t.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: loginBody(login, "wrong password", randomBytes(32).toString("hex")),
    });
  }

  test("a 7th failure right after the 30 s lock expires locks again for 60 s", async () => {
    for (let i = 0; i < 5; i++) assertError(await fail(), 401, "invalid_credentials");
    const sixth = assertError(await fail(), 429, "login_throttled");
    assert.equal(sixth.retryAfterSeconds, 30);

    t.clock.advance(30_000);
    const seventh = assertError(await fail(), 429, "login_throttled");
    assert.equal(seventh.retryAfterSeconds, 60, "n=7: min(30s * 2^1, 15min) = 60s");
  });

  test("15 minutes after the last failure the window resets: failures start at 1 again", async () => {
    t.clock.advance(15 * 60_000 + 1);
    const response = assertError(await fail(), 401, "invalid_credentials");
    assert.equal(response.code, "invalid_credentials");
    // 4 more free failures should follow (a fresh window), proving the counter really restarted.
    for (let i = 0; i < 4; i++) assertError(await fail(), 401, "invalid_credentials");
    const sixth = assertError(await fail(), 429, "login_throttled");
    assert.equal(sixth.retryAfterSeconds, 30, "back to the first lock duration in the new window");
  });
});
