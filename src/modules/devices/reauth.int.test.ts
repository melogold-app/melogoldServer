/**
 * Reauth throttling (DESIGN §4.1: `auth_throttle(scope='reauth', key=userId)`, 5 failures → 15 min; API §2.2
 * `reauth_throttled{retryAfterSeconds}`), both dialects, over HTTP (revoke by a recent device) and on the queries:
 * - five wrong passwords answer `403 invalid_password`, then `429 reauth_throttled` with `Retry-After`, even for the
 *   right password (argon2 is not called while locked);
 * - after the lock the right password passes and forgets the failures; failures older than the window are forgotten;
 * - one user's lock never touches another user; parallel failures are all counted;
 * - a full argon2 queue is `SemaphoreFullError` (`503 server_busy`).
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { argon2id, hash } from "argon2";
import { AppError } from "../../http/errors.ts";
import { HOUR_MS, MINUTE_MS } from "../../lib/clock.ts";
import { SemaphoreFullError } from "../../lib/semaphore.ts";
import { bearer, createDevice, createSession, createUser } from "../../test/factories.ts";
import { assertError, createTestApp } from "../../test/test-app.ts";
import type { TestApp } from "../../test/test-app.ts";
import { TEST_DIALECT } from "../../test/test-db.ts";
import { readReauthThrottle, recordReauthFailure } from "./devices.repository.ts";
import { checkPassword } from "./password-check.ts";
import { REAUTH_LOCK_MS, REAUTH_MAX_FAILURES, REAUTH_WINDOW_MS, reauthKeyHash, verifyReauth } from "./reauth.ts";

const PASSWORD = "две собаки и кот";
const WRONG = "три собаки и кот";
const PASSWORD_HASH = await hash(PASSWORD.normalize("NFKC"), {
  type: argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
});

let t: TestApp;

before(async () => {
  t = await createTestApp();
});

after(async () => {
  await t.close();
});

type Scene = Readonly<{ userId: string; oldId: string; meId: string }>;

/** A user whose recent device `me` needs the password to revoke the older device. */
async function scene(): Promise<Scene> {
  const now = t.clock.now();
  const user = await createUser(t.db, { now: now - 30 * 24 * HOUR_MS, passwordHash: PASSWORD_HASH });
  const old = await createDevice(t.db, user.id, { now: now - 30 * 24 * HOUR_MS, linkedVia: "register" });
  const me = await createDevice(t.db, user.id, { now: now - 1000, linkedVia: "login" });
  return { userId: user.id, oldId: old.id, meId: me.id };
}

async function revoke(s: Scene, password: string) {
  // A fresh token each time: the tests move the clock by more than the access token TTL.
  const session = await createSession(t.ctx, { userId: s.userId, deviceId: s.meId });
  return t.app.inject({
    method: "POST",
    url: `/auth/me/devices/${s.oldId}/revoke`,
    headers: { ...bearer(session.tokens.accessToken), "content-type": "application/json" },
    payload: JSON.stringify({ password }),
  });
}

async function state(userId: string) {
  return t.db.run((q) => readReauthThrottle(q, reauthKeyHash(userId)));
}

async function failTimes(s: Scene, times: number): Promise<void> {
  for (let i = 0; i < times; i++) assertError(await revoke(s, WRONG), 403, "invalid_password");
}

describe(`reauth throttle (${TEST_DIALECT})`, () => {
  test("5 failures → 429 reauth_throttled for 15 min, even with the right password; then it passes", async () => {
    const s = await scene();
    await failTimes(s, REAUTH_MAX_FAILURES);
    const start = t.clock.now();
    assert.deepEqual(await state(s.userId), {
      failures: 5,
      windowStart: start,
      lockedUntil: start + REAUTH_LOCK_MS,
    });

    const locked = await revoke(s, PASSWORD);
    const body = assertError(locked, 429, "reauth_throttled");
    assert.equal(body.retryAfterSeconds, 900);
    assert.equal(locked.headers["retry-after"], "900");

    t.clock.advance(10 * MINUTE_MS + 500);
    const later = assertError(await revoke(s, WRONG), 429, "reauth_throttled");
    assert.equal(later.retryAfterSeconds, 300, "rounded up to whole seconds");
    assert.equal((await state(s.userId))?.failures, 5, "no argon2 and no count while locked");

    t.clock.advance(5 * MINUTE_MS);
    const ok = await revoke(s, PASSWORD);
    assert.equal(ok.statusCode, 204, ok.body);
    assert.equal(await state(s.userId), undefined, "success forgets the failures");
  });

  test("a failure after the lock ended starts a new window: counted as 1, no new lock", async () => {
    const s = await scene();
    await failTimes(s, REAUTH_MAX_FAILURES);
    t.clock.advance(REAUTH_LOCK_MS);
    await failTimes(s, 1);
    assert.deepEqual(await state(s.userId), { failures: 1, windowStart: t.clock.now(), lockedUntil: null });
  });

  test("failures older than the window are forgotten", async () => {
    const s = await scene();
    await failTimes(s, REAUTH_MAX_FAILURES - 1);
    t.clock.advance(REAUTH_WINDOW_MS);
    await failTimes(s, 1);
    assert.deepEqual(await state(s.userId), { failures: 1, windowStart: t.clock.now(), lockedUntil: null });
    await failTimes(s, REAUTH_MAX_FAILURES - 1);
    assertError(await revoke(s, PASSWORD), 429, "reauth_throttled");
  });

  test("the right password forgets earlier failures", async () => {
    const s = await scene();
    await failTimes(s, REAUTH_MAX_FAILURES - 1);
    await verifyReauth(t.ctx, s.userId, PASSWORD);
    assert.equal(await state(s.userId), undefined);
    await failTimes(s, REAUTH_MAX_FAILURES - 1);
    assert.equal((await state(s.userId))?.lockedUntil, null);
  });

  test("the lock is per user", async () => {
    const locked = await scene();
    const free = await scene();
    await failTimes(locked, REAUTH_MAX_FAILURES);
    assertError(await revoke(locked, PASSWORD), 429, "reauth_throttled");
    assert.equal((await revoke(free, PASSWORD)).statusCode, 204);
  });

  test("parallel failures are all counted (one INSERT … ON CONFLICT DO UPDATE)", async () => {
    const keyHash = reauthKeyHash(`parallel-${TEST_DIALECT}`);
    const now = t.clock.now();
    const rule = { now, windowMs: REAUTH_WINDOW_MS, maxFailures: REAUTH_MAX_FAILURES, lockMs: REAUTH_LOCK_MS };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => t.db.run((q) => recordReauthFailure(q, keyHash, rule))),
    );
    assert.deepEqual(
      results.map((result) => result.failures).sort((a, b) => a - b),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
    const final = await t.db.run((q) => readReauthThrottle(q, keyHash));
    assert.deepEqual(final, { failures: 8, windowStart: now, lockedUntil: now + REAUTH_LOCK_MS });
  });

  test("a deleted user cannot reauth: 401 session_revoked", async () => {
    const s = await scene();
    await t.db.write((q) =>
      q.updateTable("users").set({ deleted_at: t.clock.now() }).where("id", "=", s.userId).execute(),
    );
    await assert.rejects(
      verifyReauth(t.ctx, s.userId, PASSWORD),
      (error: unknown) => error instanceof AppError && error.code === "session_revoked",
    );
  });

  test("a stored hash argon2 cannot parse never matches: 403 invalid_password", async () => {
    const s = await scene();
    await t.db.write((q) => q.updateTable("users").set({ password_hash: "!" }).where("id", "=", s.userId).execute());
    assertError(await revoke(s, PASSWORD), 403, "invalid_password");
  });
});

describe("argon2 semaphore", () => {
  test("a full queue rejects with SemaphoreFullError (503 server_busy)", async () => {
    const env = { ARGON2_MAX_CONCURRENCY: 1, ARGON2_QUEUE_LIMIT: 1 };
    const ctx = { env, log: { warn: () => undefined } };
    const running = checkPassword(ctx, PASSWORD_HASH, PASSWORD);
    const queued = checkPassword(ctx, PASSWORD_HASH, WRONG);
    await assert.rejects(checkPassword(ctx, PASSWORD_HASH, PASSWORD), SemaphoreFullError);
    assert.deepEqual(await Promise.all([running, queued]), [true, false]);
    // NFKC: the decomposed "й" verifies against the hash of the composed one.
    const composed = "пароль-й-12";
    const hashOfComposed = await hash(composed, { type: argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
    assert.equal(await checkPassword(ctx, hashOfComposed, composed.normalize("NFD")), true);
  });
});
