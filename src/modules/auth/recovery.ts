/**
 * Recovery codes as registration issues them (API §1.6 `RecoveryCode`, §8; DESIGN §4.9):
 *
 * - 20 characters of Crockford Base32 (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`), 100 bits: `randomBytes(20)[i] % 32`, which
 *   has no bias because 256 is a multiple of 32;
 * - shown once as `XXXX-XXXX-XXXX-XXXX-XXXX`;
 * - stored as `sha256("melogold-recovery-v1:" + code)` of the 20 characters without separators (the input form after
 *   the normalization of API §1.6), so a hash of the typed code compares directly.
 *
 * The account module (recover, rotation) reuses these helpers.
 */
import { randomBytes } from "node:crypto";
import { CROCKFORD_ALPHABET, RECOVERY_CODE_LENGTH, formatCodeGroups } from "../../contract/common.ts";
import { sha256Hex } from "../../lib/crypto.ts";

/** API §8. */
export const RECOVERY_CODE_HASH_PREFIX = "melogold-recovery-v1:";

export type NewRecoveryCode = Readonly<{
  /** 20 characters, no separators. */
  code: string;
  /** `XXXX-XXXX-XXXX-XXXX-XXXX`: what the client shows. */
  display: string;
  /** `users.recovery_code_hash`. */
  hash: string;
}>;

/** The stored hash of a normalized code (20 characters, no separators). */
export function recoveryCodeHash(code: string): string {
  return sha256Hex(`${RECOVERY_CODE_HASH_PREFIX}${code}`);
}

export function newRecoveryCode(): NewRecoveryCode {
  const bytes = randomBytes(RECOVERY_CODE_LENGTH);
  const code = Array.from(bytes, (byte) => CROCKFORD_ALPHABET.charAt(byte % 32)).join("");
  return Object.freeze({ code, display: formatCodeGroups(code), hash: recoveryCodeHash(code) });
}
