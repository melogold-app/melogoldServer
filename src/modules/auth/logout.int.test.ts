/**
 * `POST /auth/logout` (API §4.3, DESIGN §4.5, PLAN T1.1 acceptance `logout.int`): always 204; the device is removed
 * only when the presented token is current or still within its rotation grace window; a rotated token outside that
 * window is a no-op. A removal publishes `devices.updated{device_signed_out}` to the other devices, never
 * `session.invalidated` to the one that signed itself out (DESIGN §4.6 table).
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { LiveEvent } from "../../modules/live/live.events.ts";
import { bearer, createAccount, createDevice } from "../../test/factories.ts";
import type { TestAccount } from "../../test/factories.ts";
import { assertError, createTestApp, json } from "../../test/test-app.ts";
import type { TestApp } from "../../test/test-app.ts";

type Recorder = { events: LiveEvent[]; closes: string[] };

function watch(t: TestApp, userId: string, deviceId: string): Recorder {
  const recorder: Recorder = { events: [], closes: [] };
  t.ctx.live.register({
    userId,
    deviceId,
    authVersion: 1,
    expiresAt: t.clock.now() + 900_000,
    send: (event) => recorder.events.push(event),
    close: (reason) => recorder.closes.push(reason),
  });
  return recorder;
}

function logout(refreshToken: string) {
  return { refreshToken };
}

describe("POST /auth/logout: the current token", () => {
  let t: TestApp;
  let account: TestAccount;
  let other: Awaited<ReturnType<typeof createDevice>>;

  before(async () => {
    t = await createTestApp();
    account = await createAccount(t.ctx);
    other = await createDevice(t.db, account.user.id, { name: "Second device" });
  });

  after(async () => {
    await t.close();
  });

  test("204, the device is removed, and the others get devices.updated{device_signed_out} (never session.invalidated to it)", async () => {
    const ownWatch = watch(t, account.user.id, account.device.id);
    const otherWatch = watch(t, account.user.id, other.id);

    const response = await t.app.inject({
      method: "POST",
      url: "/auth/logout",
      payload: logout(account.session.tokens.refreshToken),
    });
    assert.equal(response.statusCode, 204);
    assert.equal(response.body, "");

    assert.deepEqual(ownWatch.events, [], "no session.invalidated: the device logged out itself");
    assert.deepEqual(ownWatch.closes, ["device_closed"]);
    assert.deepEqual(
      otherWatch.events.map((event) => event.type),
      ["devices.updated"],
    );
    assert.deepEqual(otherWatch.events[0]?.payload, { reason: "device_signed_out", deviceId: account.device.id });

    const row = await t.db.run((q) =>
      q.selectFrom("devices").select("id").where("id", "=", account.device.id).executeTakeFirst(),
    );
    assert.equal(row, undefined);

    const me = await t.app.inject({
      method: "GET",
      url: "/auth/me",
      headers: bearer(account.session.tokens.accessToken),
    });
    assertError(me, 401, "session_revoked");
  });

  test("logging out again with the same (now pointless) token is still 204, with no further effect", async () => {
    const response = await t.app.inject({
      method: "POST",
      url: "/auth/logout",
      payload: logout(account.session.tokens.refreshToken),
    });
    assert.equal(response.statusCode, 204);
  });
});

describe("POST /auth/logout: rotated tokens", () => {
  let t: TestApp;

  before(async () => {
    t = await createTestApp({ env: { REFRESH_GRACE_SECONDS: "60" } });
  });

  after(async () => {
    await t.close();
  });

  test("a token rotated moments ago, still within its grace window, still signs the device out", async () => {
    const account = await createAccount(t.ctx);
    const predecessor = account.session.tokens.refreshToken;
    const rotated = await t.app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken: predecessor, device: { hwid: account.device.hwid } },
    });
    assert.equal(rotated.statusCode, 200, rotated.body);

    const response = await t.app.inject({ method: "POST", url: "/auth/logout", payload: logout(predecessor) });
    assert.equal(response.statusCode, 204);

    const row = await t.db.run((q) =>
      q.selectFrom("devices").select("id").where("id", "=", account.device.id).executeTakeFirst(),
    );
    assert.equal(row, undefined, "the predecessor, still in its grace window, was enough to sign the device out");
  });

  test("a rotated token outside its grace window: 204, but no effect", async () => {
    const account = await createAccount(t.ctx);
    const predecessor = account.session.tokens.refreshToken;
    const rotated = await t.app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken: predecessor, device: { hwid: account.device.hwid } },
    });
    assert.equal(rotated.statusCode, 200, rotated.body);
    const successor = json(rotated).tokens as { refreshToken: string };

    t.clock.advance(61_000);
    const watched = watch(t, account.user.id, account.device.id);
    const response = await t.app.inject({ method: "POST", url: "/auth/logout", payload: logout(predecessor) });
    assert.equal(response.statusCode, 204);
    assert.deepEqual(watched.events, [], "no effect: nothing was published");
    assert.deepEqual(watched.closes, [], "no effect: the stream was not closed either");

    const row = await t.db.run((q) =>
      q.selectFrom("devices").select("id").where("id", "=", account.device.id).executeTakeFirst(),
    );
    assert.ok(row, "the device is still there");

    // The successor (the device's real current token) still works, proving nothing was disturbed.
    const stillWorks = await t.app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken: successor.refreshToken, device: { hwid: account.device.hwid } },
    });
    assert.equal(stillWorks.statusCode, 200, stillWorks.body);
  });
});

describe("POST /auth/logout: malformed or foreign tokens", () => {
  let t: TestApp;

  before(async () => {
    t = await createTestApp();
  });

  after(async () => {
    await t.close();
  });

  test("garbage that is not an authentic mgrt1 token: 204, no effect", async () => {
    const response = await t.app.inject({ method: "POST", url: "/auth/logout", payload: logout("not-a-token") });
    assert.equal(response.statusCode, 204);
  });

  test("a well-formed token for a device that does not exist: 204, no effect", async () => {
    const account = await createAccount(t.ctx);
    // Somebody else's account's device was already removed; only the token's HMAC is authentic here.
    const response = await t.app.inject({
      method: "POST",
      url: "/auth/logout",
      payload: logout(account.session.tokens.refreshToken),
    });
    assert.equal(response.statusCode, 204);
    const secondTry = await t.app.inject({
      method: "POST",
      url: "/auth/logout",
      payload: logout(account.session.tokens.refreshToken),
    });
    assert.equal(secondTry.statusCode, 204);
  });

  test("body validation still runs: a missing refreshToken is 400 invalid_request, not 204", async () => {
    const response = await t.app.inject({ method: "POST", url: "/auth/logout", payload: {} });
    assertError(response, 400, "invalid_request");
  });
});
