/**
 * `POST /auth/me/password` (API §4.5, DESIGN §4.8), both dialects (PLAN T1.3 `password-change.int`):
 * - without the old password from **any** signed-in device, a new one included; the others get
 *   `account.updated{password_changed_without_old}`;
 * - with the old password: a wrong one is `403 invalid_password` and counts towards the reauth lock;
 * - always `auth_version + 1`, a new token pair for the caller, the user's streams closed;
 * - `signOutOtherDevices` removes every other device (`session.invalidated{password_changed}`).
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { argon2id, hash, verify } from "argon2";
import type { LiveEvent } from "../../contract/live.ts";
import type { LiveCloseReason } from "../live/live.hub.ts";
import { HOUR_MS, MINUTE_MS } from "../../lib/clock.ts";
import { formatIso } from "../../lib/time.ts";
import { bearer, createAccount, createDevice, createSession } from "../../test/factories.ts";
import type { TestAccount, TestDevice } from "../../test/factories.ts";
import { assertError, createTestApp, json } from "../../test/test-app.ts";
import type { TestApp } from "../../test/test-app.ts";
import { reauthKeyHash } from "./account.service.ts";

const OLD_PASSWORD = "старый пароль один";
const NEW_PASSWORD = "новый длинный пароль";

let t: TestApp;

before(async () => {
  // ACCESS_TOKEN_TTL_SECONDS raised well past the 15-minute reauth lock window (DESIGN §4.1) so the reauth-throttle
  // tests below can advance the clock across a lock without the caller's own access token expiring first.
  t = await createTestApp({
    env: { ARGON2_MEMORY_KIB: "19456", ARGON2_TIME_COST: "2", ACCESS_TOKEN_TTL_SECONDS: "3600" },
  });
});

after(async () => {
  await t.close();
});

/** A cheap argon2id hash of a test password (verification reads the cost from the PHC string). */
function testHash(password: string): Promise<string> {
  return hash(password.normalize("NFKC"), { type: argon2id, memoryCost: 1024, timeCost: 1, parallelism: 1 });
}

type Listener = { events: LiveEvent[]; closed: LiveCloseReason[] };

/** A stream of the live hub as the SSE route would register it. */
function listen(userId: string, deviceId: string): Listener {
  const listener: Listener = { events: [], closed: [] };
  t.ctx.live.register({
    userId,
    deviceId,
    authVersion: 1,
    expiresAt: t.clock.now() + HOUR_MS,
    send: (event) => listener.events.push(event),
    close: (reason) => listener.closed.push(reason),
  });
  return listener;
}

type Scene = Readonly<{
  account: TestAccount;
  /** A device linked by login a moment ago: `recent` (DESIGN §4.8). */
  fresh: TestDevice;
  freshToken: string;
  other: TestDevice;
  otherToken: string;
}>;

async function scene(): Promise<Scene> {
  const account = await createAccount(t.ctx, { user: { passwordHash: await testHash(OLD_PASSWORD) } });
  t.clock.advance(MINUTE_MS);
  const fresh = await createDevice(t.db, account.user.id, {
    name: "MacBook Air",
    linkedVia: "login",
    now: t.clock.now(),
  });
  const other = await createDevice(t.db, account.user.id, { name: "Windows", linkedVia: "link", now: t.clock.now() });
  const freshSession = await createSession(t.ctx, { userId: account.user.id, deviceId: fresh.id });
  const otherSession = await createSession(t.ctx, { userId: account.user.id, deviceId: other.id });
  return {
    account,
    fresh,
    freshToken: freshSession.tokens.accessToken,
    other,
    otherToken: otherSession.tokens.accessToken,
  };
}

function post(url: string, token: string, body: unknown) {
  return t.app.inject({
    method: "POST",
    url,
    headers: { ...bearer(token), "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
}

function changePassword(token: string, body: unknown) {
  return post("/auth/me/password", token, body);
}

/** Any Bearer route of this module that proves the token is accepted (409: auth passed, the date is wrong). */
async function tokenWorks(token: string): Promise<number> {
  const response = await post("/auth/me/recovery-code/confirm", token, {
    recoveryCodeCreatedAt: "2001-01-01T00:00:00Z",
  });
  return response.statusCode;
}

async function userRow(userId: string) {
  return t.db.run((q) => q.selectFrom("users").selectAll().where("id", "=", userId).executeTakeFirstOrThrow());
}

async function refreshTokenCount(deviceId: string): Promise<number> {
  const rows = await t.db.run((q) =>
    q.selectFrom("refresh_tokens").select("id").where("device_id", "=", deviceId).execute(),
  );
  return rows.length;
}

describe("POST /auth/me/password without the old password", () => {
  test("allowed from a recent device; the others get password_changed_without_old; tokens and streams renewed", async () => {
    const s = await scene();
    const userId = s.account.user.id;
    const onOwner = listen(userId, s.account.device.id);
    const onOther = listen(userId, s.other.id);
    const onAuthor = listen(userId, s.fresh.id);
    t.clock.advance(MINUTE_MS);
    const now = t.clock.now();

    const response = await changePassword(s.freshToken, { newPassword: NEW_PASSWORD });
    assert.equal(response.statusCode, 200, response.body);
    const body = json(response) as {
      user: { id: string; passwordChangedAt: string };
      tokens: { accessToken: string; refreshToken: string };
      signedOutDevices: number;
    };
    assert.deepEqual(Object.keys(body), ["user", "tokens", "signedOutDevices"]);
    assert.equal(body.user.id, userId);
    assert.equal(body.user.passwordChangedAt, formatIso(now));
    assert.equal(body.signedOutDevices, 0);

    const expected = {
      reason: "password_changed_without_old",
      byDevice: { id: s.fresh.id, name: "MacBook Air" },
    };
    for (const listener of [onOwner, onOther]) {
      const updates = listener.events.filter((event) => event.type === "account.updated");
      assert.equal(updates.length, 1);
      assert.deepEqual(updates[0]?.payload, expected);
    }
    assert.equal(onAuthor.events.length, 0, "the author does not get its own notice");
    for (const listener of [onOwner, onOther, onAuthor]) assert.deepEqual(listener.closed, ["user_closed"]);

    const user = await userRow(userId);
    assert.equal(user.auth_version, 2);
    assert.equal(user.password_changed_at, now);
    assert.ok(await verify(user.password_hash, NEW_PASSWORD.normalize("NFKC")));

    // Old access tokens carry av=1: expired. The new pair works; the author's old refresh token is gone.
    assertError(
      await post("/auth/me/recovery-code/confirm", s.otherToken, { recoveryCodeCreatedAt: "2001-01-01T00:00:00Z" }),
      401,
      "access_token_expired",
    );
    assertError(await post("/auth/me/recovery-code/confirm", s.freshToken, {}), 401, "access_token_expired");
    assert.equal(await tokenWorks(body.tokens.accessToken), 409);
    assert.equal(await refreshTokenCount(s.fresh.id), 1);
    assert.equal(await refreshTokenCount(s.other.id), 1, "other devices stay signed in");
  });

  test("an unknown old password field is ignored only when absent: null counts as absent (API §1.3)", async () => {
    const s = await scene();
    const response = await changePassword(s.otherToken, { currentPassword: null, newPassword: NEW_PASSWORD });
    assert.equal(response.statusCode, 200, response.body);
  });
});

describe("POST /auth/me/password with the old password", () => {
  test("wrong → 403 invalid_password and nothing changes; right → 200 and password_changed", async () => {
    const s = await scene();
    const userId = s.account.user.id;
    const token = s.account.session.tokens.accessToken;
    const onOther = listen(userId, s.other.id);

    const wrong = await changePassword(token, { currentPassword: "не тот пароль", newPassword: NEW_PASSWORD });
    assertError(wrong, 403, "invalid_password");
    assert.equal((await userRow(userId)).auth_version, 1);
    assert.equal(onOther.events.length, 0);

    const right = await changePassword(token, { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    assert.equal(right.statusCode, 200, right.body);
    assert.deepEqual(
      onOther.events.map((event) => event.payload),
      [{ reason: "password_changed", byDevice: { id: s.account.device.id, name: s.account.device.name } }],
    );
    const throttle = await t.db.run((q) =>
      q.selectFrom("auth_throttle").selectAll().where("key_hash", "=", reauthKeyHash(userId)).execute(),
    );
    assert.deepEqual(throttle, [], "a successful check removes the reauth row");
  });

  test("5 wrong passwords lock the key: the 6th attempt is 429 reauth_throttled even when right, 15 min later ok", async () => {
    const s = await scene();
    const token = s.account.session.tokens.accessToken;
    for (let attempt = 1; attempt <= 5; attempt++) {
      const response = await changePassword(token, { currentPassword: `wrong ${attempt}`, newPassword: NEW_PASSWORD });
      assertError(response, 403, "invalid_password");
    }
    t.clock.advance(60_000);
    const locked = await changePassword(token, { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    const body = assertError(locked, 429, "reauth_throttled");
    assert.equal(body.retryAfterSeconds, 14 * 60);
    assert.equal(locked.headers["retry-after"], String(14 * 60));

    t.clock.advance(14 * MINUTE_MS);
    const allowed = await changePassword(token, { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    assert.equal(allowed.statusCode, 200, allowed.body);
  });

  test("failures outside the 15-minute window start a new count", async () => {
    const s = await scene();
    const token = s.account.session.tokens.accessToken;
    for (let attempt = 1; attempt <= 4; attempt++) {
      assertError(
        await changePassword(token, { currentPassword: "wrong", newPassword: NEW_PASSWORD }),
        403,
        "invalid_password",
      );
    }
    t.clock.advance(15 * MINUTE_MS);
    assertError(
      await changePassword(token, { currentPassword: "wrong", newPassword: NEW_PASSWORD }),
      403,
      "invalid_password",
    );
    const row = await t.db.run((q) =>
      q
        .selectFrom("auth_throttle")
        .select(["failures", "locked_until"])
        .where("scope", "=", "reauth")
        .where("key_hash", "=", reauthKeyHash(s.account.user.id))
        .executeTakeFirstOrThrow(),
    );
    assert.deepEqual(row, { failures: 1, locked_until: null });
  });

  test("signOutOtherDevices removes every other device, addressed session.invalidated{password_changed}", async () => {
    const s = await scene();
    const userId = s.account.user.id;
    const onAuthor = listen(userId, s.account.device.id);
    const onFresh = listen(userId, s.fresh.id);
    const onOther = listen(userId, s.other.id);

    const response = await changePassword(s.account.session.tokens.accessToken, {
      currentPassword: OLD_PASSWORD,
      newPassword: NEW_PASSWORD,
      signOutOtherDevices: true,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(json(response).signedOutDevices, 2);

    for (const listener of [onFresh, onOther]) {
      assert.deepEqual(
        listener.events.map((event) => [event.type, event.payload]),
        [["session.invalidated", { reason: "password_changed", forceRelogin: true }]],
      );
      assert.deepEqual(listener.closed, ["device_closed"]);
    }
    assert.deepEqual(
      onAuthor.events.map((event) => [event.type, event.payload]),
      [["devices.updated", { reason: "device_removed", deviceId: null }]],
    );
    assert.deepEqual(onAuthor.closed, ["user_closed"]);

    const devices = await t.db.run((q) => q.selectFrom("devices").select("id").where("user_id", "=", userId).execute());
    assert.deepEqual(
      devices.map((row) => row.id),
      [s.account.device.id],
    );
    assert.equal(await refreshTokenCount(s.fresh.id), 0);
    assertError(await post("/auth/me/recovery-code/confirm", s.freshToken, {}), 401, "session_revoked");
  });
});

describe("POST /auth/me/password: the new password policy", () => {
  test("400 password_* with details, checked before the old password (no reauth failure counted)", async () => {
    const s = await scene();
    const token = s.account.session.tokens.accessToken;
    const cases = [
      ["short", "password_too_short", { minLength: 8 }],
      ["x".repeat(129), "password_too_long", { maxLength: 128 }],
      ["melogold2026", "password_too_common", {}],
      [`my ${s.account.user.login} password`, "password_contains_login", {}],
    ] as const;
    for (const [newPassword, code, details] of cases) {
      const body = assertError(await changePassword(token, { currentPassword: "wrong", newPassword }), 400, code);
      for (const [key, value] of Object.entries(details)) assert.equal(body[key], value, code);
    }
    const throttle = await t.db.run((q) =>
      q.selectFrom("auth_throttle").selectAll().where("key_hash", "=", reauthKeyHash(s.account.user.id)).execute(),
    );
    assert.deepEqual(throttle, []);
    assert.equal((await userRow(s.account.user.id)).auth_version, 1);
  });

  test("a body without newPassword is 400 invalid_request", async () => {
    const s = await scene();
    assertError(await changePassword(s.account.session.tokens.accessToken, {}), 400, "invalid_request");
  });
});
