/**
 * `POST /auth/login` never tells an unknown login apart from a known one with the wrong password (DESIGN §4.1, PLAN
 * T1.1 acceptance `login-enumeration.int`): same refusal code, and the same argon2 work (a dummy hash of the current
 * cost stands in for the missing account, through the same semaphore the real check uses).
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { createAuthService } from "./auth.service.ts";
import { createUser, uniqueLogin } from "../../test/factories.ts";
import { assertError, createTestApp } from "../../test/test-app.ts";
import type { TestApp } from "../../test/test-app.ts";
import { Argon2Pool } from "./argon2-pool.ts";

const FAST_ARGON2 = { ARGON2_MEMORY_KIB: "19456", ARGON2_TIME_COST: "2" };
const PASSWORD = "две собаки и кот";

function device() {
  return { hwid: randomBytes(32).toString("hex"), name: "Google Pixel 8", platform: "android" };
}

function loginBody(login: string, password: string) {
  return { login, password, device: device() };
}

describe("POST /auth/login: unknown login vs. wrong password", () => {
  let t: TestApp;
  let knownLogin: string;

  before(async () => {
    t = await createTestApp({ env: FAST_ARGON2 });
    const pool = new Argon2Pool({ memoryKiB: 19_456, timeCost: 2, parallelism: 1, maxConcurrency: 2, queueLimit: 8 });
    const passwordHash = await pool.hash(PASSWORD);
    knownLogin = uniqueLogin("known");
    await createUser(t.db, { login: knownLogin, passwordHash });
  });

  after(async () => {
    await t.close();
  });

  /** The shared pool's counters: `createAuthService` reuses the one context-wide pool (`argon2PoolFor`). */
  function stats() {
    return createAuthService(t.ctx).argon2.stats;
  }

  test('both answer 401 invalid_credentials — never a distinct "no such user" code', async () => {
    const unknown = await t.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: loginBody(uniqueLogin("ghost"), "whatever password"),
    });
    assertError(unknown, 401, "invalid_credentials");

    const wrongPassword = await t.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: loginBody(knownLogin, "not the password"),
    });
    assertError(wrongPassword, 401, "invalid_credentials");
  });

  test("both cost exactly one argon2 verification through the same semaphore", async () => {
    const before = stats();
    await t.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: loginBody(uniqueLogin("ghost2"), "whatever password"),
    });
    const afterUnknown = stats();
    assert.equal(afterUnknown.verifies, before.verifies + 1);
    assert.equal(afterUnknown.hashes, before.hashes, "the dummy hash is made once and reused, not per request");

    await t.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: loginBody(knownLogin, "still not the password"),
    });
    const afterWrong = stats();
    assert.equal(afterWrong.verifies, afterUnknown.verifies + 1);
  });

  test("comparable wall-clock time: an unknown login is not answered faster than a wrong password", async () => {
    const time = async (body: ReturnType<typeof loginBody>) => {
      const start = process.hrtime.bigint();
      await t.app.inject({ method: "POST", url: "/auth/login", payload: body });
      return Number(process.hrtime.bigint() - start) / 1e6;
    };
    // Warm up (JIT, file system caches) before comparing.
    await time(loginBody(uniqueLogin("warm"), "x"));
    await time(loginBody(knownLogin, "warm-wrong"));

    const unknownMs = await time(loginBody(uniqueLogin("ghost3"), "whatever password"));
    const wrongMs = await time(loginBody(knownLogin, "still not the password"));
    // Both do one real argon2 hash of the same cost; a huge gap would mean the unknown-login path skips it.
    const ratio = Math.max(unknownMs, wrongMs) / Math.max(1, Math.min(unknownMs, wrongMs));
    assert.ok(ratio < 5, `unknown ${unknownMs}ms vs. wrong password ${wrongMs}ms (ratio ${ratio})`);
  });

  test("a malformed body never reaches argon2: invalid_request, not invalid_credentials", async () => {
    const response = await t.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { login: "", password: "x", device: device() },
    });
    assertError(response, 400, "invalid_request");
  });
});
