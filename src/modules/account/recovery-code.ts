/**
 * Recovery codes (API §1.6 `RecoveryCode`, §8; DESIGN §4.9).
 *
 * - **Format:** 20 characters of Crockford Base32 (100 bits), shown as `XXXX-XXXX-XXXX-XXXX-XXXX`. Every character is
 *   `randomBytes(20)[i] % 32`: 256 is a multiple of 32, so there is no modulo bias.
 * - **Input:** the contract normalizes it (`RecoveryCodeInput`: upper case, separators removed, `O→0`, `I,L→1`), so
 *   the service always sees the 20 characters without separators.
 * - **Storage:** `sha256("melogold-recovery-v1:" + code)` of the normalized code, lowercase hex (the `ID` column
 *   `users.recovery_code_hash`). The plain code is never stored and is shown once (register, recover, rotation, CLI).
 * - **Comparison:** constant time, and against a dummy hash when the login is unknown, so an unknown login and a
 *   wrong code cost the same and answer the same `401 invalid_recovery_code`.
 */
import { randomBytes } from "node:crypto";
import { CROCKFORD_ALPHABET, RECOVERY_CODE_LENGTH, formatCodeGroups } from "../../contract/common.ts";
import { constantTimeEqual, sha256Hex } from "../../lib/crypto.ts";

/** API §8: the hash is `sha256("melogold-recovery-v1:" + code)`. */
export const RECOVERY_CODE_HASH_PREFIX = "melogold-recovery-v1:";

/** A freshly generated code: `code` is what gets hashed, `display` is what the user sees once. */
export type IssuedRecoveryCode = Readonly<{
  /** 20 characters of {@link CROCKFORD_ALPHABET}, no separators. */
  code: string;
  /** `XXXX-XXXX-XXXX-XXXX-XXXX` (API §1.6 output form). */
  display: string;
  /** `users.recovery_code_hash`. */
  hash: string;
}>;

/** `sha256("melogold-recovery-v1:" + code)` of a normalized code (20 characters, no separators). */
export function recoveryCodeHash(normalizedCode: string): string {
  return sha256Hex(`${RECOVERY_CODE_HASH_PREFIX}${normalizedCode}`);
}

/**
 * A new recovery code.
 * @param random source of random bytes (tests pass a fixed one).
 */
export function generateRecoveryCode(random: (size: number) => Uint8Array = randomBytes): IssuedRecoveryCode {
  const bytes = random(RECOVERY_CODE_LENGTH);
  if (bytes.length !== RECOVERY_CODE_LENGTH) throw new RangeError("the random source returned a wrong number of bytes");
  let code = "";
  for (const byte of bytes) code += CROCKFORD_ALPHABET.charAt(byte % CROCKFORD_ALPHABET.length);
  return Object.freeze({ code, display: formatCodeGroups(code), hash: recoveryCodeHash(code) });
}

/**
 * Compared against when the login is unknown (DESIGN §4.9): the hash of a string that is not a recovery code, so no
 * input can match it.
 */
export const UNKNOWN_LOGIN_RECOVERY_HASH = sha256Hex(`${RECOVERY_CODE_HASH_PREFIX}no-such-login`);

/**
 * Whether a presented code (normalized) matches the stored hash, in constant time. `storedHash = null` (unknown login)
 * compares against {@link UNKNOWN_LOGIN_RECOVERY_HASH} and is always `false`.
 */
export function recoveryCodeMatches(storedHash: string | null, normalizedCode: string): boolean {
  const presented = recoveryCodeHash(normalizedCode);
  const equal = constantTimeEqual(presented, storedHash ?? UNKNOWN_LOGIN_RECOVERY_HASH);
  return equal && storedHash !== null;
}
