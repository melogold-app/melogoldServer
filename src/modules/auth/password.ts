/**
 * Login and password policy (API §1.6 `Login`, `Password`; DESIGN §4.1).
 *
 * **Login.** Every login is normalized `NFKC → trim → lowercase` ({@link normalizeLogin}); on input it is only
 * 1..64 UTF-16 units (the schema). A **new** login must match `^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$`
 * (`400 invalid_login_format`) and must not be reserved: the built-in list below plus `RESERVED_LOGINS` answer
 * `409 login_taken`, exactly like a taken login.
 *
 * **Password.** NFKC before hashing and before verification ({@link normalizePassword}; the argon2 pool applies it
 * itself), so a composed and a decomposed «й» are the same password. A **new** password
 * ({@link checkNewPassword}), in this order:
 * 1. 8..128 UTF-16 units and at most 512 UTF-8 bytes after NFKC: `password_too_short{minLength: 8}` /
 *    `password_too_long{maxLength: 128}`;
 * 2. not too common (`password_too_common`): a frequent password, a password of at most two distinct characters or a
 *    run of consecutive digits, or a denylisted word (the product words of DESIGN §4.1 and frequent password words),
 *    possibly repeated, decorated only with digits, punctuation or spaces (`Melogold2024!`, `music-music`);
 * 3. does not contain the login when the login has at least 4 characters (`password_contains_login`).
 *
 * A password that is only **checked** (login, reauth) is limited by its length alone (the schema), so a change of the
 * policy never locks anybody out.
 */
import { normalizeLogin } from "../../config/env.ts";
import { LOGIN_LIMITS, PASSWORD_LIMITS, PASSWORD_MAX_UTF8_BYTES } from "../../contract/limits.ts";
import { AppError } from "../../http/errors.ts";
import { utf8ByteLength } from "../../lib/strings.ts";

export { normalizeLogin };

/** API §1.6: a new login after normalization. */
export const NEW_LOGIN_PATTERN = new RegExp(LOGIN_LIMITS.pattern);

/**
 * Logins nobody registers (DESIGN §4.1: `admin`, `root`, `melogold`, `official`, `support`, …). `RESERVED_LOGINS`
 * adds to this list. Only logins that match {@link NEW_LOGIN_PATTERN} are listed: anything else is refused anyway.
 */
export const BUILTIN_RESERVED_LOGINS: readonly string[] = Object.freeze([
  "abuse",
  "admin",
  "administrator",
  "api",
  "help",
  "hostmaster",
  "info",
  "mailer-daemon",
  "melogold",
  "melogold-server",
  "moderator",
  "no-reply",
  "noreply",
  "null",
  "official",
  "operator",
  "owner",
  "postmaster",
  "root",
  "security",
  "server",
  "staff",
  "superuser",
  "support",
  "sys",
  "sysadmin",
  "system",
  "undefined",
  "webmaster",
  "www",
]);

/** The verdict on a new login: the normalized login, or the code to answer. */
export type NewLoginCheck =
  Readonly<{ ok: true; login: string }> | Readonly<{ ok: false; code: "invalid_login_format" | "login_taken" }>;

/**
 * Checks a login for a new account (register; the CLI may reuse it).
 * @param input the login as sent (1..64 UTF-16 units, checked by the schema).
 * @param reserved `RESERVED_LOGINS` (already normalized by `parseEnv`).
 */
export function checkNewLogin(input: string, reserved: readonly string[]): NewLoginCheck {
  const login = normalizeLogin(input);
  if (!NEW_LOGIN_PATTERN.test(login)) return { ok: false, code: "invalid_login_format" };
  if (BUILTIN_RESERVED_LOGINS.includes(login) || reserved.includes(login)) return { ok: false, code: "login_taken" };
  return { ok: true, login };
}

/** API §1.6: NFKC before hash and verify. */
export function normalizePassword(password: string): string {
  return password.normalize("NFKC");
}

/**
 * DESIGN §4.1 denylist: the words of the product and its domain, and words frequent passwords are made of. A new
 * password whose letters are exactly one of these words (whatever digits, punctuation or spaces surround them) is
 * too common. Lowercase, NFKC.
 */
export const DENYLISTED_WORDS: ReadonlySet<string> = new Set([
  // DESIGN §4.1
  "melogold",
  "мелоголд",
  "vitune",
  "music",
  "музыка",
  "youtube",
  "playlist",
  "плейлист",
  // the product's neighbours
  "clementine",
  "spotify",
  "soundcloud",
  "musica",
  "musik",
  "song",
  "songs",
  "песня",
  "песни",
  // frequent password words
  "abc",
  "abcd",
  "abcde",
  "abcdef",
  "abcdefg",
  "abcdefgh",
  "access",
  "admin",
  "administrator",
  "asdf",
  "asdfgh",
  "asdfghjkl",
  "azerty",
  "baseball",
  "batman",
  "changeme",
  "charlie",
  "computer",
  "default",
  "dragon",
  "football",
  "freedom",
  "google",
  "hello",
  "iloveu",
  "iloveyou",
  "internet",
  "letmein",
  "login",
  "love",
  "master",
  "monkey",
  "pass",
  "passw",
  "passwd",
  "password",
  "pokemon",
  "princess",
  "qaz",
  "qazwsx",
  "qwe",
  "qwer",
  "qwert",
  "qwerty",
  "qwertyu",
  "qwertyui",
  "qwertyuiop",
  "qwertz",
  "samsung",
  "secret",
  "shadow",
  "starwars",
  "sunshine",
  "superman",
  "test",
  "trustno",
  "welcome",
  "whatever",
  "zxc",
  "zxcv",
  "zxcvb",
  "zxcvbn",
  "zxcvbnm",
  "йцукен",
  "йцукенг",
  "йцукенгш",
  "йцукенгшщзхъ",
  "пароль",
  "привет",
  "любовь",
]);

/** Frequent passwords of at least 8 characters that the rules below would not catch, lowercase. */
const FREQUENT_PASSWORDS: ReadonlySet<string> = new Set(["1q2w3e4r", "1q2w3e4r5t", "1qaz2wsx", "q1w2e3r4", "zaq12wsx"]);

const DIGIT_RUNS = ["01234567890123456789", "98765432109876543210"];

function isDigitRun(value: string): boolean {
  return /^\d+$/.test(value) && DIGIT_RUNS.some((run) => run.includes(value));
}

/** Rule 2 of the module comment, on the NFKC form. */
export function isTooCommon(normalized: string): boolean {
  const lower = normalized.toLowerCase();
  if (FREQUENT_PASSWORDS.has(lower)) return true;
  if (new Set(lower).size <= 2) return true;
  if (isDigitRun(lower)) return true;
  // Everything that is not a letter (digits, punctuation, spaces, symbols) is decoration around the word, and a
  // word repeated is still that word ("music-music").
  return DENYLISTED_WORDS.has(repeatedUnit(lower.replace(/[^\p{L}]/gu, "")));
}

/** The shortest string whose repetition gives `value` ("abab" → "ab"; "abc" → "abc"). */
function repeatedUnit(value: string): string {
  const units = Array.from(value);
  for (let size = 1; size <= units.length / 2; size++) {
    if (units.length % size !== 0) continue;
    const unit = units.slice(0, size).join("");
    if (unit.repeat(units.length / size) === value) return unit;
  }
  return value;
}

/** API §2.2: why a new password is refused, with the details of the code. */
export type PasswordRefusal =
  | Readonly<{ code: "password_too_short"; minLength: number }>
  | Readonly<{ code: "password_too_long"; maxLength: number }>
  | Readonly<{ code: "password_too_common" }>
  | Readonly<{ code: "password_contains_login" }>;

/** DESIGN §4.1: the login counts only from 4 characters on. */
export const CONTAINS_LOGIN_MIN_LENGTH = 4;

/**
 * Checks a new password (register, recover, change) against the policy of the module comment.
 * @param password the password as sent.
 * @param login the normalized login of the account.
 * @returns `null` when the password is acceptable.
 */
export function checkNewPassword(password: string, login: string): PasswordRefusal | null {
  const normalized = normalizePassword(password);
  if (normalized.length < PASSWORD_LIMITS.minLength) {
    return { code: "password_too_short", minLength: PASSWORD_LIMITS.minLength };
  }
  if (normalized.length > PASSWORD_LIMITS.maxLength || utf8ByteLength(normalized) > PASSWORD_MAX_UTF8_BYTES) {
    return { code: "password_too_long", maxLength: PASSWORD_LIMITS.maxLength };
  }
  if (isTooCommon(normalized)) return { code: "password_too_common" };
  if (login.length >= CONTAINS_LOGIN_MIN_LENGTH && normalized.toLowerCase().includes(login)) {
    return { code: "password_contains_login" };
  }
  return null;
}

/** The `AppError` of a refusal. */
export function passwordRefusalError(refusal: PasswordRefusal): AppError {
  switch (refusal.code) {
    case "password_too_short":
      return new AppError("password_too_short", { details: { minLength: refusal.minLength } });
    case "password_too_long":
      return new AppError("password_too_long", { details: { maxLength: refusal.maxLength } });
    case "password_too_common":
      return new AppError("password_too_common");
    case "password_contains_login":
      return new AppError("password_contains_login");
  }
}

/**
 * {@link checkNewPassword} that throws.
 * @throws AppError `password_too_short`, `password_too_long`, `password_too_common` or `password_contains_login`.
 */
export function assertNewPassword(password: string, login: string): void {
  const refusal = checkNewPassword(password, login);
  if (refusal !== null) throw passwordRefusalError(refusal);
}
