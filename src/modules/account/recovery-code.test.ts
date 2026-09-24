/** Recovery codes (API §1.6, §8; DESIGN §4.9): format, alphabet, hash, constant-time match. */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  CROCKFORD_ALPHABET,
  RECOVERY_CODE_OUTPUT_PATTERN,
  RecoveryCodeInput,
  normalizeCrockfordCode,
} from "../../contract/common.ts";
import { sha256Hex } from "../../lib/crypto.ts";
import { TEST_RECOVERY_CODE, recoveryCodeHash as factoryHash } from "../../test/factories.ts";
import {
  UNKNOWN_LOGIN_RECOVERY_HASH,
  generateRecoveryCode,
  recoveryCodeHash,
  recoveryCodeMatches,
} from "./recovery-code.ts";

describe("generateRecoveryCode", () => {
  test("20 Crockford characters, shown as XXXX-XXXX-XXXX-XXXX-XXXX, hashed as API §8 says", () => {
    for (let i = 0; i < 50; i++) {
      const issued = generateRecoveryCode();
      assert.equal(issued.code.length, 20);
      for (const char of issued.code) assert.ok(CROCKFORD_ALPHABET.includes(char), char);
      assert.match(issued.display, RECOVERY_CODE_OUTPUT_PATTERN);
      assert.equal(issued.display.replaceAll("-", ""), issued.code);
      assert.equal(issued.hash, sha256Hex(`melogold-recovery-v1:${issued.code}`));
      assert.match(issued.hash, /^[0-9a-f]{64}$/);
    }
  });

  test("each byte maps to alphabet[byte % 32]: no bias, every symbol reachable", () => {
    const bytes = Uint8Array.from({ length: 20 }, (_, i) => i * 13 + 7);
    const issued = generateRecoveryCode(() => bytes);
    const expected = [...bytes].map((byte) => CROCKFORD_ALPHABET.charAt(byte % 32)).join("");
    assert.equal(issued.code, expected);
    assert.equal(256 % CROCKFORD_ALPHABET.length, 0);
    const all = generateRecoveryCode(() => Uint8Array.from({ length: 20 }, (_, i) => 255 - i));
    assert.equal(all.code, [...Array(20).keys()].map((i) => CROCKFORD_ALPHABET.charAt((255 - i) % 32)).join(""));
  });

  test("a wrong number of random bytes is a bug", () => {
    assert.throws(() => generateRecoveryCode(() => new Uint8Array(19)), RangeError);
  });

  test("codes differ", () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateRecoveryCode().code));
    assert.equal(codes.size, 200);
  });
});

describe("recoveryCodeHash and recoveryCodeMatches", () => {
  test("the hash of the normalized code equals the test factories' stored hash", () => {
    const normalized = normalizeCrockfordCode(TEST_RECOVERY_CODE, 20);
    assert.ok(normalized);
    assert.equal(recoveryCodeHash(normalized), factoryHash(TEST_RECOVERY_CODE));
  });

  test("the user's typing normalizes to the same code (API §1.6 input rule)", () => {
    const issued = generateRecoveryCode(() => Uint8Array.from({ length: 20 }, (_, i) => [0, 1, 1, 0][i % 4] ?? 0));
    assert.equal(issued.code.slice(0, 4), "0110");
    const typed = issued.display.toLowerCase().replaceAll("0", "o").replaceAll("1", "l").replaceAll("-", " ");
    const parsed = RecoveryCodeInput.parse(typed);
    assert.equal(parsed, issued.code);
    assert.ok(recoveryCodeMatches(issued.hash, parsed));
  });

  test("a wrong code or an unknown login never matches", () => {
    const issued = generateRecoveryCode();
    const other = generateRecoveryCode();
    assert.ok(recoveryCodeMatches(issued.hash, issued.code));
    assert.ok(!recoveryCodeMatches(issued.hash, other.code));
    assert.ok(!recoveryCodeMatches(null, issued.code));
    assert.match(UNKNOWN_LOGIN_RECOVERY_HASH, /^[0-9a-f]{64}$/);
  });
});
