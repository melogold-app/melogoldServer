/**
 * The login and password policy (API §1.6, §2.2; DESIGN §4.1; PLAN T1.1 `password-policy.test`): the four refusal
 * codes of a new password with their details, NFKC for the composed and the decomposed «й», new logins.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AppError } from "../../http/errors.ts";
import {
  BUILTIN_RESERVED_LOGINS,
  NEW_LOGIN_PATTERN,
  assertNewPassword,
  checkNewLogin,
  checkNewPassword,
  isTooCommon,
  normalizeLogin,
  normalizePassword,
} from "./password.ts";

/** «й» as one code point (U+0439) and as «и» + combining breve (U+0438 U+0306). */
const Y_COMPOSED = "й";
const Y_DECOMPOSED = "й";

describe("new password: the four refusal codes", () => {
  test("password_too_short with minLength 8, counted in UTF-16 units after NFKC", () => {
    assert.deepEqual(checkNewPassword("Kx9-vR2", "maxim"), { code: "password_too_short", minLength: 8 });
    assert.equal(checkNewPassword("Kx9-vR2q", "maxim"), null);
    // Four emoji are 8 UTF-16 units (4 code points): long enough.
    assert.equal(checkNewPassword("🎵🎶🎸🎹", "maxim"), null);
    assert.deepEqual(checkNewPassword("🎵🎶🎸", "maxim"), { code: "password_too_short", minLength: 8 });
    // Seven decomposed «й» are 14 units as sent but 7 after NFKC.
    assert.deepEqual(checkNewPassword(Y_DECOMPOSED.repeat(7), "maxim"), { code: "password_too_short", minLength: 8 });
  });

  test("password_too_long with maxLength 128", () => {
    const ok = "Nq7-vR2k-Lp9x-Wt4m".padEnd(128, "z");
    assert.equal(checkNewPassword(ok, "maxim"), null);
    assert.deepEqual(checkNewPassword(`${ok}z`, "maxim"), { code: "password_too_long", maxLength: 128 });
    // 65 emoji are 130 units.
    assert.deepEqual(checkNewPassword("🎵".repeat(65), "maxim"), { code: "password_too_long", maxLength: 128 });
    // A ligature expands under NFKC: "ﬀ" (1 unit) → "ff" (2 units).
    assert.deepEqual(checkNewPassword("ﬀ".repeat(65), "maxim"), { code: "password_too_long", maxLength: 128 });
  });

  test("password_too_common: the DESIGN §4.1 denylist, decorated words, frequent passwords", () => {
    for (const password of [
      "melogold",
      "Melogold2024!",
      "мелоголд123",
      "vitune2025",
      "music-music",
      "MUSIC 12345",
      "музыка2000",
      "youtube1",
      "playlist",
      "плейлист!!",
      "password",
      "Password123!",
      "qwerty123",
      "1q2w3e4r",
      "12345678",
      "87654321",
      "11111111",
      "abababab",
      "пароль2024",
      "йцукен123",
    ]) {
      assert.deepEqual(checkNewPassword(password, "maxim"), { code: "password_too_common" }, password);
    }
    for (const password of [
      "две собаки и кот",
      "melogold is my favourite app",
      "Nq7-vR2k-Lp9x-Wt4m",
      "12345679",
      "музыка ночью в поезде",
    ]) {
      assert.equal(checkNewPassword(password, "maxim"), null, password);
    }
  });

  test("password_contains_login when the login has at least 4 characters, case-insensitive", () => {
    assert.deepEqual(checkNewPassword("my-MAXIM-password-x", "maxim"), { code: "password_contains_login" });
    assert.deepEqual(checkNewPassword("xx-anna.b-xx-42", "anna.b"), { code: "password_contains_login" });
    // A 3-character login does not count.
    assert.equal(checkNewPassword("bob-likes-long-walks", "bob"), null);
  });

  test("assertNewPassword throws the AppError of each code with its details", () => {
    const codes = [
      ["short", "password_too_short", { minLength: 8 }],
      ["x".repeat(129), "password_too_long", { maxLength: 128 }],
      ["melogold", "password_too_common", {}],
      ["i-am-maxim-really", "password_contains_login", {}],
    ] as const;
    for (const [password, code, details] of codes) {
      assert.throws(
        () => {
          assertNewPassword(password, "maxim");
        },
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, code);
          assert.deepEqual({ ...error.details }, details);
          return true;
        },
      );
    }
    assert.doesNotThrow(() => {
      assertNewPassword("две собаки и кот", "maxim");
    });
  });
});

describe("NFKC (API §1.6)", () => {
  test("the composed and the decomposed «й» give the same password", () => {
    const composed = `мой ${Y_COMPOSED}орк 2024`;
    const decomposed = `мой ${Y_DECOMPOSED}орк 2024`;
    assert.notEqual(composed, decomposed);
    assert.equal(normalizePassword(decomposed), composed);
    assert.equal(normalizePassword(composed), composed);
    assert.equal(checkNewPassword(decomposed, "maxim"), null);
  });

  test("compatibility forms fold: full-width letters, ligatures", () => {
    assert.equal(normalizePassword("ＰＡＳＳ"), "PASS");
    assert.equal(normalizePassword("ﬁ"), "fi");
    assert.equal(isTooCommon(normalizePassword("ｐａｓｓｗｏｒｄ")), true);
  });
});

describe("new login (API §1.6)", () => {
  test("normalization NFKC → trim → lowercase, then the pattern", () => {
    assert.equal(normalizeLogin("  Maxim "), "maxim");
    assert.equal(normalizeLogin("ＭＡＸＩＭ"), "maxim");
    assert.deepEqual(checkNewLogin("Maxim", []), { ok: true, login: "maxim" });
    assert.deepEqual(checkNewLogin("anna.b-42_x", []), { ok: true, login: "anna.b-42_x" });
    assert.equal(NEW_LOGIN_PATTERN.source, "^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$");
  });

  test("invalid_login_format: too short, too long, bad characters, bad ends", () => {
    for (const login of ["ab", "a".repeat(33), "max im", "макс", "-maxim", "maxim.", "max@im", ""]) {
      assert.deepEqual(checkNewLogin(login, []), { ok: false, code: "invalid_login_format" }, login);
    }
    assert.deepEqual(checkNewLogin("abc", []), { ok: true, login: "abc" });
    assert.deepEqual(checkNewLogin("a".repeat(32), []), { ok: true, login: "a".repeat(32) });
  });

  test("reserved logins (built in and RESERVED_LOGINS) answer login_taken", () => {
    for (const login of ["admin", "Root", "melogold", "OFFICIAL", "support"]) {
      assert.deepEqual(checkNewLogin(login, []), { ok: false, code: "login_taken" }, login);
    }
    assert.deepEqual(checkNewLogin("owner-bob", ["owner-bob"]), { ok: false, code: "login_taken" });
    for (const login of BUILTIN_RESERVED_LOGINS) assert.ok(NEW_LOGIN_PATTERN.test(login), login);
  });
});
