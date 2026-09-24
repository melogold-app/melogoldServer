/**
 * `POST /auth/me/recovery-code` and `/confirm` (API §4.5, DESIGN §4.9), both dialects: the two new SQL queries of
 * this route (`replaceRecoveryCode`, `confirmRecoveryCode` in `account.repository.ts`) get their own coverage here,
 * distinct from `recovery-code.test.ts` (the pure `code ↔ hash` functions) and from the reauth-lock mechanics
 * already exercised end to end by `password-change.int.test.ts` on the sibling `/auth/me/password` route.
 * - right password → 200, a new unconfirmed code, `recovery_code_hash`/`created_at` replaced, others notified with
 *   `account.updated{recovery_code_rotated}`;
 * - wrong password → 403 `invalid_password`, nothing changes;
 * - `/confirm` with the current `recoveryCodeCreatedAt` → 204, sets `recovery_code_confirmed_at` once (idempotent);
 * - `/confirm` with a stale `recoveryCodeCreatedAt` (rotated since) → 409 `recovery_code_outdated`.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { argon2id, hash } from "argon2";
import type { LiveEvent } from "../../contract/live.ts";
import { formatIso } from "../../lib/time.ts";
import { bearer, createAccount, createDevice } from "../../test/factories.ts";
import { assertError, createTestApp, json } from "../../test/test-app.ts";
import type { TestApp } from "../../test/test-app.ts";

const PASSWORD = "код восстановления пароль";

let t: TestApp;

before(async () => {
  t = await createTestApp();
});

after(async () => {
  await t.close();
});

function testHash(password: string): Promise<string> {
  return hash(password.normalize("NFKC"), { type: argon2id, memoryCost: 1024, timeCost: 1, parallelism: 1 });
}

function post(url: string, token: string, body: unknown) {
  return t.app.inject({
    method: "POST",
    url,
    headers: { ...bearer(token), "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
}

function rotate(token: string, password: string) {
  return post("/auth/me/recovery-code", token, { password });
}

function confirm(token: string, recoveryCodeCreatedAt: string) {
  return post("/auth/me/recovery-code/confirm", token, { recoveryCodeCreatedAt });
}

async function userRow(userId: string) {
  return t.db.run((q) =>
    q
      .selectFrom("users")
      .select(["recovery_code_hash", "recovery_code_created_at", "recovery_code_confirmed_at"])
      .where("id", "=", userId)
      .executeTakeFirstOrThrow(),
  );
}

describe("POST /auth/me/recovery-code", () => {
  test("right password: new unconfirmed code, hash and createdAt replaced, others notified", async () => {
    const account = await createAccount(t.ctx, { user: { passwordHash: await testHash(PASSWORD) } });
    const other = await createDevice(t.db, account.user.id, {
      name: "iPad",
      linkedVia: "link",
      now: t.clock.now(),
    });
    const listener: { events: LiveEvent[] } = { events: [] };
    t.ctx.live.register({
      userId: account.user.id,
      deviceId: other.id,
      authVersion: 1,
      expiresAt: t.clock.now() + 3_600_000,
      send: (event) => listener.events.push(event),
      close: () => undefined,
    });

    const before = await userRow(account.user.id);
    t.clock.advance(60_000);

    const response = await rotate(account.session.tokens.accessToken, PASSWORD);
    assert.equal(response.statusCode, 200, response.body);
    const body = json(response) as { recoveryCode: string; createdAt: string };
    assert.deepEqual(Object.keys(body).sort(), ["createdAt", "recoveryCode"]);
    assert.match(body.recoveryCode, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){4}$/);

    const after = await userRow(account.user.id);
    assert.notEqual(after.recovery_code_hash, before.recovery_code_hash);
    assert.notEqual(after.recovery_code_created_at, before.recovery_code_created_at);
    assert.equal(after.recovery_code_confirmed_at, null, "a freshly rotated code starts unconfirmed");

    assert.deepEqual(
      listener.events.map((event) => [event.type, event.payload]),
      [
        [
          "account.updated",
          { reason: "recovery_code_rotated", byDevice: { id: account.device.id, name: account.device.name } },
        ],
      ],
    );
  });

  test("wrong password → 403 invalid_password; nothing changes", async () => {
    const account = await createAccount(t.ctx, { user: { passwordHash: await testHash(PASSWORD) } });
    const before = await userRow(account.user.id);
    const response = await rotate(account.session.tokens.accessToken, "не тот пароль");
    assertError(response, 403, "invalid_password");
    assert.deepEqual(await userRow(account.user.id), before);
  });

  test("a body without a password is 400 invalid_request", async () => {
    const account = await createAccount(t.ctx);
    assertError(await post("/auth/me/recovery-code", account.session.tokens.accessToken, {}), 400, "invalid_request");
  });
});

describe("POST /auth/me/recovery-code/confirm", () => {
  test("the current recoveryCodeCreatedAt → 204, sets confirmed_at once (idempotent)", async () => {
    const account = await createAccount(t.ctx);
    const before = await userRow(account.user.id);
    assert.equal(before.recovery_code_confirmed_at, null);
    const createdAtIso = formatIso(before.recovery_code_created_at);

    const first = await confirm(account.session.tokens.accessToken, createdAtIso);
    assert.equal(first.statusCode, 204, first.body);
    assert.equal(first.body, "");
    const afterFirst = await userRow(account.user.id);
    assert.notEqual(afterFirst.recovery_code_confirmed_at, null);

    t.clock.advance(60_000);
    const second = await confirm(account.session.tokens.accessToken, createdAtIso);
    assert.equal(second.statusCode, 204, second.body);
    const afterSecond = await userRow(account.user.id);
    assert.equal(
      afterSecond.recovery_code_confirmed_at,
      afterFirst.recovery_code_confirmed_at,
      "confirming again does not move the timestamp",
    );
  });

  test("a stale recoveryCodeCreatedAt (rotated since) → 409 recovery_code_outdated", async () => {
    const account = await createAccount(t.ctx, { user: { passwordHash: await testHash(PASSWORD) } });
    const before = await userRow(account.user.id);
    const staleIso = formatIso(before.recovery_code_created_at);

    t.clock.advance(60_000);
    assert.equal((await rotate(account.session.tokens.accessToken, PASSWORD)).statusCode, 200);

    assertError(await confirm(account.session.tokens.accessToken, staleIso), 409, "recovery_code_outdated");
    assert.equal((await userRow(account.user.id)).recovery_code_confirmed_at, null);
  });
});
