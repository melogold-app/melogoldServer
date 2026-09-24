/**
 * Proof of work (API §4.3, DESIGN §4.2): the vectors of `spec/pow.vectors.json` (the same for every client), the
 * difficulty table, and the gate: required, invalid, one use, expiry, forgery.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { MINUTE_MS } from "../../lib/clock.ts";
import { POW_CHALLENGE_PREFIX, openCompact, signCompact } from "../../lib/tokens.ts";
import {
  POW_CHALLENGE_TTL_MS,
  PowGate,
  RegistrationWindow,
  leadingZeroBits,
  meetsDifficulty,
  powDifficulty,
  powDigest,
  readPowSolution,
  solvePow,
} from "./pow.ts";

type Vectors = {
  license: string;
  solutions: { challenge: string; bits: number; nonce: string; sha256: string }[];
  leadingZeroBits: { sha256: string; bits: number }[];
  difficulty: { baseBits: number; softPerHour: number; registrationsLastHour: number; bits: number }[];
};

const VECTORS = JSON.parse(readFileSync(new URL("../../../spec/pow.vectors.json", import.meta.url), "utf8")) as Vectors;

const KEY = Buffer.alloc(32, 3);
const OTHER_KEY = Buffer.alloc(32, 4);
const T0 = Date.UTC(2026, 8, 23, 10, 0, 0);

describe("spec/pow.vectors.json", () => {
  test("is CC0 and non-empty", () => {
    assert.equal(VECTORS.license, "CC0-1.0");
    assert.ok(VECTORS.solutions.length >= 5);
  });

  test("every solution: the digest, enough zero bits, and (up to 12 bits) no smaller nonce works", () => {
    for (const vector of VECTORS.solutions) {
      const digest = powDigest(vector.challenge, vector.nonce);
      assert.equal(digest.toString("hex"), vector.sha256, vector.challenge);
      assert.ok(leadingZeroBits(digest) >= vector.bits, vector.challenge);
      assert.ok(meetsDifficulty(vector.challenge, vector.nonce, vector.bits));
      if (vector.bits <= 12) assert.equal(solvePow(vector.challenge, vector.bits), vector.nonce, vector.challenge);
    }
  });

  test("leading zero bits", () => {
    for (const vector of VECTORS.leadingZeroBits) {
      assert.equal(leadingZeroBits(Buffer.from(vector.sha256, "hex")), vector.bits, vector.sha256);
    }
  });

  test("difficulty table", () => {
    for (const vector of VECTORS.difficulty) {
      assert.equal(powDifficulty(vector), vector.bits, JSON.stringify(vector));
    }
  });
});

describe("RegistrationWindow", () => {
  test("counts the registrations of the last hour", () => {
    const window = new RegistrationWindow();
    window.record(T0);
    window.record(T0 + 30 * MINUTE_MS);
    assert.equal(window.count(T0 + 30 * MINUTE_MS), 2);
    assert.equal(window.count(T0 + 60 * MINUTE_MS), 1);
    assert.equal(window.count(T0 + 91 * MINUTE_MS), 0);
  });
});

describe("readPowSolution (the raw body, before the schema)", () => {
  test("absent or null → null; a well-formed object → the solution; anything else → malformed", () => {
    assert.equal(readPowSolution({ login: "x" }), null);
    assert.equal(readPowSolution({ pow: null }), null);
    assert.equal(readPowSolution([]), null);
    assert.equal(readPowSolution("x"), null);
    assert.deepEqual(readPowSolution({ pow: { challenge: "mgpow1.a.b", nonce: "12" } }), {
      challenge: "mgpow1.a.b",
      nonce: "12",
    });
    for (const pow of ["x", 1, [], { challenge: "c" }, { challenge: "c", nonce: 1 }, { challenge: "c", nonce: "-1" }]) {
      assert.equal(readPowSolution({ pow }), "malformed", JSON.stringify(pow));
    }
    assert.equal(readPowSolution({ pow: { challenge: "c".repeat(257), nonce: "1" } }), "malformed");
  });
});

describe("PowGate", () => {
  const gate = (baseBits: number, softPerHour = 60) => new PowGate({ key: KEY, baseBits, softPerHour });

  test("off (0 bits): every request passes, with or without pow", () => {
    const off = gate(0);
    assert.equal(off.requiredBits(T0), 0);
    assert.equal(off.check(null, T0), "ok");
    assert.equal(off.check("malformed", T0), "ok");
  });

  test("a challenge carries the bits and the expiry; its payload is signed", () => {
    const on = gate(8);
    const issued = on.issue(T0);
    assert.equal(issued.bits, 8);
    assert.equal(issued.expiresAt, new Date(T0 + POW_CHALLENGE_TTL_MS).toISOString());
    assert.match(issued.challenge, /^mgpow1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    assert.ok(issued.challenge.length <= 256);
    const payload = openCompact(POW_CHALLENGE_PREFIX, issued.challenge, KEY, 256) as Record<string, unknown>;
    assert.equal(payload.b, 8);
    assert.equal(payload.exp, T0 + POW_CHALLENGE_TTL_MS);
    assert.notEqual(on.issue(T0).challenge, issued.challenge, "every challenge is new");
  });

  test("required: no solution → required; a solution → ok once, then invalid", () => {
    const on = gate(8);
    assert.equal(on.check(null, T0), "required");
    const { challenge } = on.issue(T0);
    const nonce = solvePow(challenge, 8);
    assert.equal(on.check({ challenge, nonce }, T0 + 1000), "ok");
    assert.equal(on.check({ challenge, nonce }, T0 + 2000), "invalid", "one use");
  });

  test("invalid: too few zero bits, forged, expired, malformed, easier than required now", () => {
    const on = gate(8);
    const { challenge } = on.issue(T0);
    let wrong = 0;
    while (meetsDifficulty(challenge, String(wrong), 8)) wrong += 1;
    assert.equal(on.check({ challenge, nonce: String(wrong) }, T0), "invalid");

    const forgedPayload = signCompact(POW_CHALLENGE_PREFIX, { n: "abcdefghijkl", b: 0, exp: T0 + 60_000 }, OTHER_KEY);
    assert.equal(on.check({ challenge: forgedPayload, nonce: "0" }, T0), "invalid");

    const late = on.issue(T0);
    const lateNonce = solvePow(late.challenge, 8);
    assert.equal(on.check({ challenge: late.challenge, nonce: lateNonce }, T0 + POW_CHALLENGE_TTL_MS), "invalid");

    assert.equal(on.check("malformed", T0), "invalid");

    const easy = signCompact(POW_CHALLENGE_PREFIX, { n: "abcdefghijkl", b: 4, exp: T0 + 60_000 }, KEY);
    assert.equal(on.check({ challenge: easy, nonce: solvePow(easy, 4) }, T0), "invalid");

    // The valid solution of the first challenge still works: the refusals used nothing up.
    assert.equal(on.check({ challenge, nonce: solvePow(challenge, 8) }, T0), "ok");
  });

  test("adaptive: above the hourly threshold proof of work switches on at 16 bits", () => {
    const adaptive = gate(0, 2);
    for (let i = 0; i < 2; i++) adaptive.recordRegistration(T0);
    assert.equal(adaptive.requiredBits(T0), 0);
    adaptive.recordRegistration(T0);
    assert.equal(adaptive.requiredBits(T0), 16);
    assert.equal(adaptive.issue(T0).bits, 16);
    assert.equal(adaptive.check(null, T0), "required");
    for (let i = 0; i < 2; i++) adaptive.recordRegistration(T0);
    assert.equal(adaptive.requiredBits(T0), 20);
    assert.equal(adaptive.requiredBits(T0 + 61 * MINUTE_MS), 0, "the hour passed");
  });
});
