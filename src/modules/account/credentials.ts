/**
 * Logins and passwords as the account module needs them (API §1.6, DESIGN §4.1): normalization, the policy for a
 * **new** password, and argon2id behind a semaphore.
 *
 * **Ownership note.** PLAN T1.1 owns the canonical versions (`src/modules/auth/password.ts`, `argon2-pool.ts`), which
 * were written in parallel with this module. This file implements the same rules so that T1.3 works on its own; the
 * lead replaces it with imports from `auth/` when both are merged, so that the whole process shares **one** argon2
 * semaphore (`ARGON2_MAX_CONCURRENCY`) and one denylist. Nothing outside `src/modules/account` imports it.
 *
 * - Login: `NFKC → trim → lowercase`; on input only 1..64 characters are checked (the contract does it).
 * - Password: NFKC before hashing and before verification. A new password is 8..128 UTF-16 units and at most 512
 *   UTF-8 bytes, not too common (denylist), and does not contain the login when the login has at least 4
 *   characters. The refusal codes are `password_too_short{minLength}`, `password_too_long{maxLength}`,
 *   `password_too_common`, `password_contains_login` (API §2.2).
 * - argon2id with `ARGON2_MEMORY_KIB` / `ARGON2_TIME_COST` / `ARGON2_PARALLELISM`, at most `ARGON2_MAX_CONCURRENCY`
 *   at a time, `ARGON2_QUEUE_LIMIT` waiting; overflow is `SemaphoreFullError` → `503 server_busy{5}` (the error
 *   handler maps it). Never inside a database transaction (docs/database.md §2.3).
 */
import { argon2id, hash as argon2Hash, verify as argon2Verify } from "argon2";
import type { HashOptions } from "argon2";
import type { Env } from "../../config/env.ts";
import { PASSWORD_LIMITS, PASSWORD_MAX_UTF8_BYTES } from "../../contract/limits.ts";
import { AppError } from "../../http/errors.ts";
import { Semaphore } from "../../lib/semaphore.ts";
import { utf8ByteLength } from "../../lib/strings.ts";

/** API §1.6 `Login`: NFKC → trim → lowercase. */
export function normalizeLogin(login: string): string {
  return login.normalize("NFKC").trim().toLowerCase();
}

/** API §1.6 `Password`: NFKC before hash and verify. */
export function normalizePassword(password: string): string {
  return password.normalize("NFKC");
}

/** DESIGN §4.1: the login is refused inside the password only from this length on. */
export const LOGIN_IN_PASSWORD_MIN_LENGTH = 4;

/**
 * DESIGN §4.1 denylist: words that make a password "too common" when the password is the word itself, or the word
 * with digits or symbols around it (`music123`, `!playlist!`).
 */
const DENYLIST_WORDS: ReadonlySet<string> = new Set([
  "melogold",
  "мелоголд",
  "vitune",
  "music",
  "музыка",
  "youtube",
  "playlist",
  "плейлист",
  "password",
  "passw0rd",
  "пароль",
  "qwerty",
  "йцукен",
  "iloveyou",
  "sunshine",
  "princess",
  "football",
  "baseball",
  "welcome",
  "letmein",
  "superman",
  "starwars",
  "whatever",
  "dragon",
  "monkey",
  "master",
  "shadow",
  "computer",
  "internet",
  "admin",
  "qwertyuiop",
  "asdfghjkl",
  "zxcvbnm",
]);

/** Frequent passwords of at least 8 characters that are not a denylisted word with decorations. */
const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  "12345678",
  "123456789",
  "1234567890",
  "0123456789",
  "87654321",
  "987654321",
  "11223344",
  "12341234",
  "12344321",
  "123123123",
  "1q2w3e4r",
  "1q2w3e4r5t",
  "q1w2e3r4",
  "q1w2e3r4t5",
  "1qaz2wsx",
  "zaq12wsx",
  "qazwsxedc",
  "123qweasd",
  "qwe123qwe",
  "abc12345",
  "abcd1234",
  "abcdefgh",
  "aa123456",
  "trustno1",
]);

export type PasswordPolicyViolation =
  | Readonly<{ code: "password_too_short"; minLength: number }>
  | Readonly<{ code: "password_too_long"; maxLength: number }>
  | Readonly<{ code: "password_too_common" }>
  | Readonly<{ code: "password_contains_login" }>;

function isTooCommon(lower: string): boolean {
  if (COMMON_PASSWORDS.has(lower)) return true;
  if (/^(.)\1+$/u.test(lower)) return true;
  const core = lower.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
  return core !== "" && DENYLIST_WORDS.has(core);
}

/**
 * Checks a **new** password (register, recover, change) against the policy of DESIGN §4.1.
 * @param password as received (NFKC is applied here).
 * @param login the normalized login of the account.
 * @returns the first violation, or `null`.
 */
export function checkNewPassword(password: string, login: string): PasswordPolicyViolation | null {
  const normalized = normalizePassword(password);
  if (normalized.length < PASSWORD_LIMITS.minLength) {
    return { code: "password_too_short", minLength: PASSWORD_LIMITS.minLength };
  }
  if (normalized.length > PASSWORD_LIMITS.maxLength || utf8ByteLength(normalized) > PASSWORD_MAX_UTF8_BYTES) {
    return { code: "password_too_long", maxLength: PASSWORD_LIMITS.maxLength };
  }
  const lower = normalized.toLowerCase();
  if (isTooCommon(lower)) return { code: "password_too_common" };
  if (login.length >= LOGIN_IN_PASSWORD_MIN_LENGTH && lower.includes(login)) return { code: "password_contains_login" };
  return null;
}

/**
 * {@link checkNewPassword} as a refusal.
 * @throws AppError `password_too_short`, `password_too_long`, `password_too_common` or `password_contains_login`.
 */
export function assertNewPassword(password: string, login: string): void {
  const violation = checkNewPassword(password, login);
  if (violation === null) return;
  switch (violation.code) {
    case "password_too_short":
      throw new AppError("password_too_short", { details: { minLength: violation.minLength } });
    case "password_too_long":
      throw new AppError("password_too_long", { details: { maxLength: violation.maxLength } });
    case "password_too_common":
      throw new AppError("password_too_common");
    case "password_contains_login":
      throw new AppError("password_contains_login");
  }
}

export type Argon2Env = Pick<
  Env,
  "ARGON2_MEMORY_KIB" | "ARGON2_TIME_COST" | "ARGON2_PARALLELISM" | "ARGON2_MAX_CONCURRENCY" | "ARGON2_QUEUE_LIMIT"
>;

/** argon2id behind the semaphore of DESIGN §4.1. */
export type PasswordHasher = Readonly<{
  /** PHC string of `NFKC(password)` with the configured cost. */
  hash(password: string): Promise<string>;
  /** Whether `NFKC(password)` matches the PHC string; a malformed stored hash (`'!'` of a deleted user) is `false`. */
  verify(passwordHash: string, password: string): Promise<boolean>;
}>;

export function createPasswordHasher(env: Argon2Env): PasswordHasher {
  const semaphore = new Semaphore({ concurrency: env.ARGON2_MAX_CONCURRENCY, queueLimit: env.ARGON2_QUEUE_LIMIT });
  const options: HashOptions = {
    type: argon2id,
    memoryCost: env.ARGON2_MEMORY_KIB,
    timeCost: env.ARGON2_TIME_COST,
    parallelism: env.ARGON2_PARALLELISM,
  };
  return Object.freeze({
    hash: (password: string) => semaphore.run(() => argon2Hash(normalizePassword(password), options)),
    verify: (passwordHash: string, password: string) =>
      semaphore.run(async () => {
        try {
          return await argon2Verify(passwordHash, normalizePassword(password));
        } catch {
          return false;
        }
      }),
  });
}
