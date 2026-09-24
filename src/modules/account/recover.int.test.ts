/**
 * `POST /auth/recover` (API §4.5, DESIGN §4.9), both dialects (PLAN T1.3 `recover.int`):
 * - of two parallel recovers with the same code, exactly one succeeds (CAS on the old recovery code hash);
 * - an unknown login and a wrong code answer identically (`401 invalid_recovery_code`, DESIGN §4.9 enumeration
 *   protection);
 * - every previous device is removed: `session.invalidated{recovery_reset}`, then the guard itself answers
 *   `session_revoked` for their old tokens;
 * - a new, unconfirmed recovery code is issued; the new device is `linked_via: "recovery"` (not `recent`);
 * - a soft-deleted account cannot be recovered (the lookup itself excludes `deleted_at IS NOT NULL`).
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { LiveEvent } from "../../contract/live.ts";
import type { LiveCloseReason } from "../live/live.hub.ts";
import { bearer, createAccount, createDevice, recoveryCodeHash, TEST_RECOVERY_CODE } from "../../test/factories.ts";
import { assertError, createTestApp, json } from "../../test/test-app.ts";
import type { TestApp } from "../../test/test-app.ts";

const NEW_PASSWORD = "новый длинный пароль";
const HWID = "3fa9c1d2e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1";
const DEVICE = { hwid: HWID, name: "Google Pixel 8", platform: "android" };

let t: TestApp;

before(async () => {
  t = await createTestApp();
});

after(async () => {
  await t.close();
});

type Listener = { events: LiveEvent[]; closed: LiveCloseReason[] };

function listen(userId: string, deviceId: string): Listener {
  const listener: Listener = { events: [], closed: [] };
  t.ctx.live.register({
    userId,
    deviceId,
    authVersion: 1,
    expiresAt: t.clock.now() + 3_600_000,
    send: (event) => listener.events.push(event),
    close: (reason) => listener.closed.push(reason),
  });
  return listener;
}

function recover(body: unknown) {
  return t.app.inject({
    method: "POST",
    url: "/auth/recover",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
}

async function userRow(userId: string) {
  return t.db.run((q) => q.selectFrom("users").selectAll().where("id", "=", userId).executeTakeFirst());
}

describe("POST /auth/recover", () => {
  test("right login and code: new password, new device, new code, old devices removed", async () => {
    const account = await createAccount(t.ctx);
    const other = await createDevice(t.db, account.user.id, {
      name: "Windows",
      platform: "windows",
      linkedVia: "login",
      now: t.clock.now(),
    });
    const onOwner = listen(account.user.id, account.device.id);
    const onOther = listen(account.user.id, other.id);

    const response = await recover({
      login: account.user.login.toUpperCase(),
      recoveryCode: TEST_RECOVERY_CODE.toLowerCase().replaceAll("-", " "),
      newPassword: NEW_PASSWORD,
      device: DEVICE,
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = json(response) as {
      user: { id: string; login: string };
      device: { id: string; linkedVia: string; recentUntil: string | null; isCurrent: boolean };
      tokens: { accessToken: string };
      serverId: string;
      recoveryCode: string;
      signedOutDevices: number;
    };
    assert.deepEqual(Object.keys(body).sort(), [
      "device",
      "recoveryCode",
      "serverId",
      "serverTime",
      "signedOutDevices",
      "tokens",
      "user",
    ]);
    assert.equal(body.user.id, account.user.id);
    assert.equal(body.device.linkedVia, "recovery");
    assert.equal(body.device.recentUntil, null, "linked_via=recovery is never recent (DESIGN §4.8)");
    assert.equal(body.device.isCurrent, true);
    assert.equal(body.serverId, t.ctx.serverId);
    assert.equal(body.signedOutDevices, 2, "both previous devices were removed");
    assert.notEqual(body.recoveryCode.replaceAll("-", ""), TEST_RECOVERY_CODE.replaceAll("-", ""));

    const row = await userRow(account.user.id);
    assert.equal(row?.auth_version, 2);
    assert.equal(row.recovery_code_confirmed_at, null, "the new code starts unconfirmed");
    assert.equal(row.recovery_code_hash, recoveryCodeHash(body.recoveryCode));

    const devices = await t.db.run((q) =>
      q.selectFrom("devices").select(["id", "linked_via"]).where("user_id", "=", account.user.id).execute(),
    );
    assert.deepEqual(devices, [{ id: body.device.id, linked_via: "recovery" }]);

    for (const listener of [onOwner, onOther]) {
      assert.deepEqual(
        listener.events.map((event) => [event.type, event.payload]),
        [["session.invalidated", { reason: "recovery_reset", forceRelogin: true }]],
      );
      assert.deepEqual(listener.closed, ["device_closed"]);
    }

    // The old devices are truly gone: the guard itself answers session_revoked for their stale tokens.
    assertError(
      await t.app.inject({
        method: "GET",
        url: "/auth/me/export",
        headers: bearer(account.session.tokens.accessToken),
      }),
      401,
      "session_revoked",
    );

    // The freshly issued token for the new device works.
    const works = await t.app.inject({
      method: "GET",
      url: "/auth/me/export",
      headers: bearer(body.tokens.accessToken),
    });
    assert.equal(works.statusCode, 200, works.body);
  });

  test("an unknown login and a wrong code answer identically", async () => {
    const account = await createAccount(t.ctx);
    const unknownLogin = await recover({
      login: "no-such-user-at-all",
      recoveryCode: TEST_RECOVERY_CODE,
      newPassword: NEW_PASSWORD,
      device: DEVICE,
    });
    const wrongCode = await recover({
      login: account.user.login,
      recoveryCode: "0000-0000-0000-0000-0000",
      newPassword: NEW_PASSWORD,
      device: DEVICE,
    });
    assert.equal(unknownLogin.statusCode, wrongCode.statusCode);
    assert.deepEqual(json(unknownLogin), json(wrongCode));
    assertError(unknownLogin, 401, "invalid_recovery_code");

    // Nothing changed for the real account.
    assert.equal((await userRow(account.user.id))?.auth_version, 1);
  });

  test("of two parallel recovers with the same code, exactly one succeeds", async () => {
    const account = await createAccount(t.ctx);
    const body = (login: string) => ({
      login,
      recoveryCode: TEST_RECOVERY_CODE,
      newPassword: NEW_PASSWORD,
      device: DEVICE,
    });
    const [first, second] = await Promise.all([recover(body(account.user.login)), recover(body(account.user.login))]);
    const results = [first, second].map((response) => response.statusCode).sort();
    assert.deepEqual(results, [200, 401]);
    const winner = first.statusCode === 200 ? first : second;
    const loser = first.statusCode === 200 ? second : first;
    assertError(loser, 401, "invalid_recovery_code");
    assert.equal((await userRow(account.user.id))?.auth_version, 2, "exactly one recover applied");
    // Exactly one new device exists (the winner's): the loser created none.
    const devices = await t.db.run((q) =>
      q.selectFrom("devices").select("id").where("user_id", "=", account.user.id).execute(),
    );
    assert.equal(devices.length, 1);
    assert.equal(devices[0]?.id, (json(winner) as { device: { id: string } }).device.id);
  });

  test("the new password policy is checked before the code (400 password_*, no device created)", async () => {
    const account = await createAccount(t.ctx);
    // Syntactically a well-formed code (so it passes schema validation) but not the account's actual code.
    const response = await recover({
      login: account.user.login,
      recoveryCode: "0000-0000-0000-0000-0000",
      newPassword: "short",
      device: DEVICE,
    });
    assertError(response, 400, "password_too_short");
    assert.equal((await userRow(account.user.id))?.auth_version, 1);
  });

  test("a soft-deleted account cannot be recovered: the lookup itself excludes it (401 invalid_recovery_code)", async () => {
    const account = await createAccount(t.ctx);
    await t.db.write((q) =>
      q
        .updateTable("users")
        .set({ deleted_at: t.clock.now(), login: `!deleted:${account.user.id}` })
        .where("id", "=", account.user.id)
        .execute(),
    );
    const response = await recover({
      login: account.user.login,
      recoveryCode: TEST_RECOVERY_CODE,
      newPassword: NEW_PASSWORD,
      device: DEVICE,
    });
    assertError(response, 401, "invalid_recovery_code");
  });

  test("a body without a device is 400 invalid_request", async () => {
    const account = await createAccount(t.ctx);
    assertError(
      await recover({ login: account.user.login, recoveryCode: TEST_RECOVERY_CODE, newPassword: NEW_PASSWORD }),
      400,
      "invalid_request",
    );
  });
});
