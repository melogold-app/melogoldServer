/**
 * `POST /auth/login` beyond enumeration and throttling (API §4.3, DESIGN §4.1, §4.6; `auth.repository.ts` queries not
 * already covered by `login-enumeration.int.test.ts` and `throttle.int.test.ts`, AGENTS.md rule 5): a known
 * `(user, hwid)` reuses its device row and starts a new token family without checking the device limit; a brand-new
 * device is created under the limit and announced over SSE; `needsRehash` upgrades the stored hash after a
 * successful login.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { Argon2Pool } from "./argon2-pool.ts";
import type { LiveEvent } from "../../modules/live/live.events.ts";
import { createDevice, createUser, uniqueLogin } from "../../test/factories.ts";
import { assertError, createTestApp, json } from "../../test/test-app.ts";
import type { TestApp } from "../../test/test-app.ts";

const FAST_ARGON2 = { ARGON2_MEMORY_KIB: "19456", ARGON2_TIME_COST: "2" };
const PASSWORD = "две собаки и кот";

function watch(t: TestApp, userId: string, deviceId: string) {
  const events: LiveEvent[] = [];
  t.ctx.live.register({
    userId,
    deviceId,
    authVersion: 1,
    expiresAt: t.clock.now() + 900_000,
    send: (event) => events.push(event),
    close: () => undefined,
  });
  return events;
}

function loginBody(login: string, hwid: string, patch: Record<string, unknown> = {}) {
  return { login, password: PASSWORD, device: { hwid, name: "Google Pixel 8", platform: "android", ...patch } };
}

describe("POST /auth/login: a known device", () => {
  let t: TestApp;
  let login: string;
  let userId: string;
  let knownHwid: string;
  let deviceId: string;
  let oldRefreshToken: string;

  before(async () => {
    t = await createTestApp({ env: FAST_ARGON2 });
    const pool = new Argon2Pool({ memoryKiB: 19_456, timeCost: 2, parallelism: 1, maxConcurrency: 2, queueLimit: 8 });
    const passwordHash = await pool.hash(PASSWORD);
    login = uniqueLogin("known-device");
    const user = await createUser(t.db, { login, passwordHash });
    userId = user.id;
    knownHwid = randomBytes(32).toString("hex");
    const device = await createDevice(t.db, userId, { hwid: knownHwid, name: "Old name" });
    deviceId = device.id;
    // A first session, so we can prove it dies when the device logs in again.
    const first = await t.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: loginBody(login, knownHwid),
    });
    assert.equal(first.statusCode, 200, first.body);
    oldRefreshToken = (json(first).tokens as { refreshToken: string }).refreshToken;
  });

  after(async () => {
    await t.close();
  });

  test("reuses the device row (same id), updates its reported metadata, and starts a new token family", async () => {
    const events = watch(t, userId, deviceId);
    const response = await t.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: loginBody(login, knownHwid, { name: "New name", clientVersion: "2.0.0" }),
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = json(response) as { device: { id: string; reportedName: string; clientVersion: string | null } };
    assert.equal(body.device.id, deviceId, "the same device row, not a new one");
    assert.equal(body.device.reportedName, "New name");
    assert.equal(body.device.clientVersion, "2.0.0");
    assert.deepEqual(events, [], 'no devices.updated: reusing a device is not "added"');

    const rows = await t.db.run((q) =>
      q.selectFrom("refresh_tokens").select("id").where("device_id", "=", deviceId).execute(),
    );
    assert.equal(rows.length, 1, "the previous token family is gone, replaced by exactly one new token");

    // The row is gone outright (replaceDeviceTokens deletes the whole family), so refresh treats it like any
    // unknown token id: session_revoked (no restore grace is open in this test).
    const staleRefresh = await t.app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken: oldRefreshToken, device: { hwid: knownHwid } },
    });
    assertError(staleRefresh, 401, "session_revoked");
  });

  test("the login clears any throttle row for this login", async () => {
    // A wrong-password failure first, to have something to clear.
    await t.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { ...loginBody(login, knownHwid), password: "x" },
    });
    const row = await t.db.run((q) =>
      q.selectFrom("auth_throttle").select("failures").where("scope", "=", "login").executeTakeFirst(),
    );
    assert.ok(row, "the failure was counted");

    const success = await t.app.inject({ method: "POST", url: "/auth/login", payload: loginBody(login, knownHwid) });
    assert.equal(success.statusCode, 200, success.body);
    const cleared = await t.db.run((q) =>
      q.selectFrom("auth_throttle").select("failures").where("scope", "=", "login").executeTakeFirst(),
    );
    assert.equal(cleared, undefined, "a successful login deletes the throttle row");
  });
});

describe("POST /auth/login: a brand-new device", () => {
  let t: TestApp;
  let login: string;
  let userId: string;

  before(async () => {
    t = await createTestApp({ env: FAST_ARGON2 });
    const pool = new Argon2Pool({ memoryKiB: 19_456, timeCost: 2, parallelism: 1, maxConcurrency: 2, queueLimit: 8 });
    const passwordHash = await pool.hash(PASSWORD);
    login = uniqueLogin("new-device");
    const user = await createUser(t.db, { login, passwordHash });
    userId = user.id;
  });

  after(async () => {
    await t.close();
  });

  test("creates a device (linked_via='login'), announces devices.updated{device_added}, marked recent", async () => {
    const marker = await createDevice(t.db, userId, { name: "Marker (to receive the SSE event)" });
    const events = watch(t, userId, marker.id);

    const hwid = randomBytes(32).toString("hex");
    const response = await t.app.inject({ method: "POST", url: "/auth/login", payload: loginBody(login, hwid) });
    assert.equal(response.statusCode, 200, response.body);
    const body = json(response) as {
      device: { id: string; linkedVia: string; recentUntil: string | null };
    };
    assert.equal(body.device.linkedVia, "login");
    assert.notEqual(body.device.recentUntil, null, 'a device created via login is still "new"');

    assert.deepEqual(
      events.map((event) => event.type),
      ["devices.updated"],
    );
    assert.deepEqual(events[0]?.payload, { reason: "device_added", deviceId: body.device.id });
  });
});

describe("POST /auth/login: the device limit", () => {
  let t: TestApp;
  let login: string;
  let knownHwid: string;

  before(async () => {
    t = await createTestApp({ env: { ...FAST_ARGON2, MAX_DEVICES_PER_USER: "1" } });
    const pool = new Argon2Pool({ memoryKiB: 19_456, timeCost: 2, parallelism: 1, maxConcurrency: 2, queueLimit: 8 });
    const passwordHash = await pool.hash(PASSWORD);
    login = uniqueLogin("limited");
    const user = await createUser(t.db, { login, passwordHash });
    knownHwid = randomBytes(32).toString("hex");
    await createDevice(t.db, user.id, { hwid: knownHwid });
  });

  after(async () => {
    await t.close();
  });

  test("a brand-new device is refused once the limit is reached", async () => {
    const response = await t.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: loginBody(login, randomBytes(32).toString("hex")),
    });
    const body = assertError(response, 409, "device_limit_reached");
    assert.equal(body.deviceLimit, 1);
    assert.equal(body.deviceCount, 1);
  });

  test("the already-known device still gets in: the limit never applies to a reused device", async () => {
    const response = await t.app.inject({ method: "POST", url: "/auth/login", payload: loginBody(login, knownHwid) });
    assert.equal(response.statusCode, 200, response.body);
  });
});

describe("POST /auth/login: needsRehash after a parameter change", () => {
  test("a successful login with a stronger ARGON2_TIME_COST rehashes the stored password", async () => {
    // The account's hash was made at the weakest allowed cost; the server now requires one more time-cost round.
    const weak = new Argon2Pool({ memoryKiB: 19_456, timeCost: 2, parallelism: 1, maxConcurrency: 2, queueLimit: 8 });
    const passwordHash = await weak.hash(PASSWORD);

    const t = await createTestApp({ env: { ARGON2_MEMORY_KIB: "19456", ARGON2_TIME_COST: "3" } });
    try {
      const login = uniqueLogin("rehash");
      const user = await createUser(t.db, { login, passwordHash });
      const response = await t.app.inject({
        method: "POST",
        url: "/auth/login",
        payload: loginBody(login, randomBytes(32).toString("hex")),
      });
      assert.equal(response.statusCode, 200, response.body);

      const row = await t.db.run((q) =>
        q.selectFrom("users").select("password_hash").where("id", "=", user.id).executeTakeFirstOrThrow(),
      );
      assert.notEqual(row.password_hash, passwordHash, "the stored hash was replaced");
      // node-argon2 orders PHC parameters m,p,t (not the RFC 9106 m,t,p; see argon2-pool.test.ts).
      assert.match(row.password_hash, /,t=3\$/, "the new hash uses the stronger time cost");

      // The new hash still verifies the same password, and login works with it going forward.
      const again = await t.app.inject({
        method: "POST",
        url: "/auth/login",
        payload: loginBody(login, randomBytes(32).toString("hex")),
      });
      assert.equal(again.statusCode, 200, again.body);
    } finally {
      await t.close();
    }
  });
});
