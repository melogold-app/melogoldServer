/**
 * Proof of work end to end through the real routes (API §4.3, DESIGN §4.2, PLAN T1.1 acceptance `pow.int`): the pure
 * gate is `pow.test.ts`; this file wires `GET /auth/register/challenge` and `POST /auth/register` together, and the
 * adaptive difficulty through a real `pow.recordRegistration()` after commit.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { leadingZeroBits, powDigest, solvePow } from "./pow.ts";
import { assertError, createTestApp, json } from "../../test/test-app.ts";
import type { TestApp } from "../../test/test-app.ts";

const FAST_ARGON2 = { ARGON2_MEMORY_KIB: "19456", ARGON2_TIME_COST: "2" };

function device() {
  return { hwid: randomBytes(32).toString("hex"), name: "Google Pixel 8", platform: "android" };
}

function registerBody(login: string, pow?: { challenge: string; nonce: string }) {
  return { login, password: "две собаки и кот", device: device(), ...(pow ? { pow } : {}) };
}

async function challengeOf(t: TestApp): Promise<{ challenge: string; bits: number }> {
  const response = await t.app.inject({ method: "GET", url: "/auth/register/challenge" });
  assert.equal(response.statusCode, 200);
  return json(response) as unknown as { challenge: string; bits: number };
}

describe("proof of work required (REGISTRATION_POW_BITS > 0)", () => {
  let t: TestApp;

  before(async () => {
    t = await createTestApp({ env: { ...FAST_ARGON2, REGISTRATION: "open", REGISTRATION_POW_BITS: "8" } });
  });

  after(async () => {
    await t.close();
  });

  test("/server/info advertises features.registrationPow while it is required", async () => {
    const response = await t.app.inject({ method: "GET", url: "/server/info" });
    const body = json(response) as { features: Record<string, unknown> };
    assert.deepEqual(body.features.registrationPow, { version: 1 });
  });

  test("without a solution: pow_required", async () => {
    const response = await t.app.inject({ method: "POST", url: "/auth/register", payload: registerBody("nopow") });
    assertError(response, 403, "pow_required");
  });

  test("a solved challenge registers; the same solution reused → pow_invalid", async () => {
    const { challenge, bits } = await challengeOf(t);
    const nonce = solvePow(challenge, bits);
    const ok = await t.app.inject({
      method: "POST",
      url: "/auth/register",
      payload: registerBody("solved", { challenge, nonce }),
    });
    assert.equal(ok.statusCode, 201, ok.body);

    const reused = await t.app.inject({
      method: "POST",
      url: "/auth/register",
      payload: registerBody("reused", { challenge, nonce }),
    });
    assertError(reused, 403, "pow_invalid");
  });

  test("a solution below the required bits → pow_invalid", async () => {
    const { challenge, bits } = await challengeOf(t);
    // A nonce that meets fewer than the required leading zero bits: any nonce that does not solve at `bits`.
    let weak: string | null = null;
    for (let nonce = 0; nonce < 1_000_000; nonce++) {
      const text = String(nonce);
      if (leadingZeroBits(powDigest(challenge, text)) < bits) {
        weak = text;
        break;
      }
    }
    assert.ok(weak !== null, "a weak solution exists below 1e6 nonces");
    const response = await t.app.inject({
      method: "POST",
      url: "/auth/register",
      payload: registerBody("weak", { challenge, nonce: weak }),
    });
    assertError(response, 403, "pow_invalid");
  });

  test("a forged challenge (wrong signature) → pow_invalid", async () => {
    const { challenge } = await challengeOf(t);
    const forged = `${challenge.slice(0, -1)}${challenge.endsWith("A") ? "B" : "A"}`;
    const response = await t.app.inject({
      method: "POST",
      url: "/auth/register",
      payload: registerBody("forged", { challenge: forged, nonce: "0" }),
    });
    assertError(response, 403, "pow_invalid");
  });
});

describe("proof of work off by default (REGISTRATION_POW_BITS = 0)", () => {
  let t: TestApp;

  before(async () => {
    t = await createTestApp({ env: FAST_ARGON2 });
  });

  after(async () => {
    await t.close();
  });

  test("/server/info has no registrationPow feature", async () => {
    const response = await t.app.inject({ method: "GET", url: "/server/info" });
    const body = json(response) as { features: Record<string, unknown> };
    assert.equal(body.features.registrationPow, undefined);
  });

  test("registration succeeds without any pow field", async () => {
    const response = await t.app.inject({ method: "POST", url: "/auth/register", payload: registerBody("free") });
    assert.equal(response.statusCode, 201, response.body);
  });
});

describe("adaptive difficulty (DESIGN §4.2): base 0, switches on above REGISTRATION_POW_SOFT_PER_HOUR", () => {
  let t: TestApp;

  before(async () => {
    t = await createTestApp({ env: { ...FAST_ARGON2, REGISTRATION: "open", REGISTRATION_POW_SOFT_PER_HOUR: "1" } });
  });

  after(async () => {
    await t.close();
  });

  test("registering more than the soft limit in the last hour raises the next challenge to 16 bits", async () => {
    const before = await challengeOf(t);
    assert.equal(before.bits, 0);

    const first = await t.app.inject({ method: "POST", url: "/auth/register", payload: registerBody("first") });
    assert.equal(first.statusCode, 201, first.body);
    const afterOne = await challengeOf(t);
    assert.equal(afterOne.bits, 0, "one registration is still within the free soft limit");

    const second = await t.app.inject({ method: "POST", url: "/auth/register", payload: registerBody("second") });
    assert.equal(second.statusCode, 201, second.body);
    const afterTwo = await challengeOf(t);
    assert.equal(afterTwo.bits, 16, "above the soft limit, proof of work switches on at 16 bits");

    // The new difficulty is enforced: registering now needs a real solution.
    const blocked = await t.app.inject({ method: "POST", url: "/auth/register", payload: registerBody("third") });
    assertError(blocked, 403, "pow_required");
    const nonce = solvePow(afterTwo.challenge, afterTwo.bits);
    const solved = await t.app.inject({
      method: "POST",
      url: "/auth/register",
      payload: registerBody("third", { challenge: afterTwo.challenge, nonce }),
    });
    assert.equal(solved.statusCode, 201, solved.body);
  });

  test("an hour later the window is clear again", async () => {
    t.clock.advance(61 * 60_000);
    const challenge = await challengeOf(t);
    assert.equal(challenge.bits, 0);
  });
});
