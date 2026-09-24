/** The new-password policy, normalization and argon2 of the account module (DESIGN §4.1, API §1.6, §2.2). */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseEnv } from "../../config/env.ts";
import { AppError } from "../../http/errors.ts";
import { SemaphoreFullError } from "../../lib/semaphore.ts";
import { assertNewPassword, checkNewPassword, createPasswordHasher, normalizeLogin } from "./credentials.ts";

describe("normalizeLogin", () => {
  test("NFKC → trim → lowercase", () => {
    assert.equal(normalizeLogin("  Maxim "), "maxim");
    assert.equal(normalizeLogin("ＭＡＸＩＭ"), "maxim");
  });
});

describe("checkNewPassword", () => {
  test("the four refusal codes with their details", () => {
    assert.deepEqual(checkNewPassword("short", "maxim"), { code: "password_too_short", minLength: 8 });
    assert.deepEqual(checkNewPassword("x".repeat(129), "maxim"), { code: "password_too_long", maxLength: 128 });
    // 128 UTF-16 units but more than 512 UTF-8 bytes.
    assert.deepEqual(checkNewPassword("😀".repeat(64) + "д", "maxim"), { code: "password_too_long", maxLength: 128 });
    assert.deepEqual(checkNewPassword("melogold", "maxim"), { code: "password_too_common" });
    assert.deepEqual(checkNewPassword("Music2026!", "maxim"), { code: "password_too_common" });
    assert.deepEqual(checkNewPassword("12345678", "maxim"), { code: "password_too_common" });
    assert.deepEqual(checkNewPassword("aaaaaaaaaa", "maxim"), { code: "password_too_common" });
    assert.deepEqual(checkNewPassword("мой MAXIM пароль", "maxim"), { code: "password_contains_login" });
  });

  test("accepted passwords; a login shorter than 4 may appear in the password", () => {
    assert.equal(checkNewPassword("две собаки и кот", "maxim"), null);
    assert.equal(checkNewPassword("новый длинный пароль", "maxim"), null);
    assert.equal(checkNewPassword(`${"ab3".repeat(42)}zz`, "maxim"), null);
    assert.equal(checkNewPassword("abc and more words", "abc"), null);
    assert.equal(checkNewPassword("music is my life, really", "maxim"), null);
  });

  test("lengths are measured after NFKC", () => {
    // U+FB01 (ﬁ) becomes "fi": 7 UTF-16 units before, 8 after.
    assert.equal(checkNewPassword("\uFB01quartz", "maxim"), null);
    // "e" + U+0301 composes to "é": 8 units before, 4 after.
    assert.deepEqual(checkNewPassword("e\u0301".repeat(4), "maxim"), { code: "password_too_short", minLength: 8 });
  });

  test("assertNewPassword throws the AppError of the violation", () => {
    assert.throws(
      () => {
        assertNewPassword("short", "maxim");
      },
      (error: unknown) =>
        error instanceof AppError && error.code === "password_too_short" && error.details.minLength === 8,
    );
    assert.throws(
      () => {
        assertNewPassword("x".repeat(200), "maxim");
      },
      (error: unknown) =>
        error instanceof AppError && error.code === "password_too_long" && error.details.maxLength === 128,
    );
    assert.doesNotThrow(() => {
      assertNewPassword("две собаки и кот", "maxim");
    });
  });
});

describe("createPasswordHasher", () => {
  const env = parseEnv({ NODE_ENV: "test", ARGON2_MEMORY_KIB: "19456", ARGON2_TIME_COST: "2" });

  test("argon2id PHC; NFKC: the composed and the decomposed «й» verify alike", async () => {
    const hasher = createPasswordHasher(env);
    const composed = "мой пароль й";
    const decomposed = composed.normalize("NFD");
    assert.notEqual(composed, decomposed);
    const hash = await hasher.hash(composed);
    assert.match(hash, /^\$argon2id\$v=19\$/);
    assert.match(hash, /[$,]m=19456[,$]/);
    assert.match(hash, /[$,]t=2[,$]/);
    assert.equal(await hasher.verify(hash, decomposed), true);
    assert.equal(await hasher.verify(hash, "другой пароль"), false);
  });

  test("a stored hash that is not a PHC string never verifies", async () => {
    const hasher = createPasswordHasher(env);
    assert.equal(await hasher.verify("!", "anything at all"), false);
  });

  test("beyond ARGON2_QUEUE_LIMIT waiting callers: SemaphoreFullError (→ 503 server_busy)", async () => {
    const tight = createPasswordHasher({ ...env, ARGON2_MAX_CONCURRENCY: 1, ARGON2_QUEUE_LIMIT: 0 });
    const first = tight.hash("first long password");
    await assert.rejects(tight.hash("second long password"), SemaphoreFullError);
    await first;
  });
});
