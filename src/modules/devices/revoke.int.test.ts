/**
 * `POST /auth/me/devices/{deviceId}/revoke` and `/revoke-others` (API §4.4, PLAN T1.2 `revoke.int`), both dialects:
 * - the own device → `409 cannot_revoke_current_device`, nothing happens;
 * - after commit, in this order: `session.invalidated{device_revoked}` to the revoked device → its streams close →
 *   `devices.updated{device_removed}` to the devices that remain (DESIGN §4.6);
 * - unfinished links approved by the revoked device become `cancelled`;
 * - the revoked device's access token answers `401 session_revoked`;
 * - unknown and foreign devices → `404 device_not_found`.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { LiveEvent } from "../../contract/live.ts";
import { DAY_MS } from "../../lib/clock.ts";
import { newId } from "../../lib/ids.ts";
import { hashToken } from "../../lib/tokens.ts";
import { bearer, createAccount, createDevice, createSession } from "../../test/factories.ts";
import type { TestAccount } from "../../test/factories.ts";
import { assertError, createTestApp, json } from "../../test/test-app.ts";
import type { TestApp } from "../../test/test-app.ts";
import { TEST_DIALECT } from "../../test/test-db.ts";

let t: TestApp;

before(async () => {
  t = await createTestApp();
});

after(async () => {
  await t.close();
});

/** What every fake SSE stream saw, in one global order: `<name> <event type> <payload>` or `<name> close <reason>`. */
let journal: string[] = [];

function watch(userId: string, deviceId: string, name: string): void {
  t.ctx.live.register({
    userId,
    deviceId,
    authVersion: 1,
    expiresAt: t.clock.now() + DAY_MS,
    send: (event: LiveEvent) => journal.push(`${name} ${event.type} ${JSON.stringify(event.payload)}`),
    close: (reason) => journal.push(`${name} close ${reason}`),
  });
}

type Family = Readonly<{ account: TestAccount; token: string; a: string; b: string }>;

/**
 * A registered account (`me`, not recent) with two more devices `a` and `b` created earlier, so no password is ever
 * needed; every device has a stream (`a` has two).
 */
async function family(): Promise<Family> {
  const account = await createAccount(t.ctx);
  const userId = account.user.id;
  const a = await createDevice(t.db, userId, { now: t.clock.now() - DAY_MS, linkedVia: "login", name: "A" });
  const b = await createDevice(t.db, userId, { now: t.clock.now() - DAY_MS, linkedVia: "login", name: "B" });
  await createSession(t.ctx, { userId, deviceId: a.id });
  await createSession(t.ctx, { userId, deviceId: b.id });
  journal = [];
  watch(userId, account.device.id, "me");
  watch(userId, a.id, "a1");
  watch(userId, a.id, "a2");
  watch(userId, b.id, "b");
  return { account, token: account.session.tokens.accessToken, a: a.id, b: b.id };
}

function post(url: string, token: string, body: object = {}) {
  return t.app.inject({
    method: "POST",
    url,
    headers: { ...bearer(token), "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
}

async function deviceIds(userId: string): Promise<string[]> {
  const rows = await t.db.run((q) => q.selectFrom("devices").select("id").where("user_id", "=", userId).execute());
  return rows.map((row) => row.id).sort();
}

async function insertLink(userId: string, approverDeviceId: string, status: string): Promise<string> {
  const id = newId();
  const now = t.clock.now();
  await t.db.write((q) =>
    q
      .insertInto("device_links")
      .values({
        id,
        mode: "invite",
        status,
        token_hash: hashToken(`t${id}`),
        code_hash: hashToken(`c${id}`),
        user_id: userId,
        approver_device_id: approverDeviceId,
        creator_net: "203.0.113.7",
        created_at: now,
        expires_at: now + 300_000,
      })
      .execute(),
  );
  return id;
}

async function linkStatus(id: string): Promise<string> {
  const row = await t.db.run((q) =>
    q.selectFrom("device_links").select("status").where("id", "=", id).executeTakeFirstOrThrow(),
  );
  return row.status;
}

const invalidated = '{"reason":"device_revoked","forceRelogin":true}';
const removedOne = (deviceId: string) => `{"reason":"device_removed","deviceId":"${deviceId}"}`;

describe(`revoke (${TEST_DIALECT})`, () => {
  test("the own device: 409 cannot_revoke_current_device, nothing happens", async () => {
    const f = await family();
    const response = await post(`/auth/me/devices/${f.account.device.id}/revoke`, f.token);
    assertError(response, 409, "cannot_revoke_current_device");
    assert.equal((await deviceIds(f.account.user.id)).length, 3);
    assert.deepEqual(journal, []);
  });

  test("order after commit: session.invalidated → streams closed → devices.updated to the others", async () => {
    const f = await family();
    const response = await post(`/auth/me/devices/${f.a}/revoke`, f.token);
    assert.equal(response.statusCode, 204, response.body);
    assert.equal(response.body, "");
    assert.deepEqual(journal, [
      `a1 session.invalidated ${invalidated}`,
      `a2 session.invalidated ${invalidated}`,
      "a1 close device_closed",
      "a2 close device_closed",
      `me devices.updated ${removedOne(f.a)}`,
      `b devices.updated ${removedOne(f.a)}`,
    ]);
    assert.deepEqual(await deviceIds(f.account.user.id), [f.account.device.id, f.b].sort());
  });

  test("unfinished links approved by the revoked device become cancelled", async () => {
    const f = await family();
    const userId = f.account.user.id;
    const links: Record<string, string> = {};
    for (const status of ["pending", "claimed", "approved", "completed", "denied"]) {
      links[status] = await insertLink(userId, f.a, status);
    }
    const byOther = await insertLink(userId, f.b, "pending");
    assert.equal((await post(`/auth/me/devices/${f.a}/revoke`, f.token)).statusCode, 204);
    for (const status of ["pending", "claimed", "approved"])
      assert.equal(await linkStatus(links[status]!), "cancelled");
    for (const status of ["completed", "denied"]) assert.equal(await linkStatus(links[status]!), status);
    assert.equal(await linkStatus(byOther), "pending");
  });

  test("the revoked device's access token is refused: 401 session_revoked", async () => {
    const f = await family();
    const victim = await createSession(t.ctx, { userId: f.account.user.id, deviceId: f.b });
    assert.equal((await post(`/auth/me/devices/${f.b}/revoke`, f.token)).statusCode, 204);
    const response = await t.app.inject({
      method: "GET",
      url: "/auth/me/devices",
      headers: bearer(victim.tokens.accessToken),
    });
    assertError(response, 401, "session_revoked");
  });

  test("unknown, foreign or already revoked device: 404 device_not_found; a malformed id: 400", async () => {
    const f = await family();
    const stranger = await createAccount(t.ctx);
    assertError(await post(`/auth/me/devices/${newId()}/revoke`, f.token), 404, "device_not_found");
    assertError(await post(`/auth/me/devices/${stranger.device.id}/revoke`, f.token), 404, "device_not_found");
    assert.deepEqual(await deviceIds(stranger.user.id), [stranger.device.id]);
    assert.equal((await post(`/auth/me/devices/${f.a}/revoke`, f.token)).statusCode, 204);
    assertError(await post(`/auth/me/devices/${f.a}/revoke`, f.token), 404, "device_not_found");
    assertError(await post("/auth/me/devices/NOT-A-UUID/revoke", f.token), 400, "invalid_request");
  });
});

describe(`revoke-others (${TEST_DIALECT})`, () => {
  test("removes every other device: each is invalidated and closed, then one devices.updated", async () => {
    const f = await family();
    const links = [
      await insertLink(f.account.user.id, f.a, "claimed"),
      await insertLink(f.account.user.id, f.b, "pending"),
    ];
    const response = await post("/auth/me/devices/revoke-others", f.token);
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(json(response), { revokedCount: 2 });
    assert.deepEqual(await deviceIds(f.account.user.id), [f.account.device.id]);
    for (const link of links) assert.equal(await linkStatus(link), "cancelled");

    // Removal order is by id (`removeDevicesInTx` keeps the order given, the list is read by lastSeenAt then id).
    const order = [f.a, f.b].sort();
    const streams = (id: string) => (id === f.a ? ["a1", "a2"] : ["b"]);
    const expected: string[] = [];
    for (const id of order) {
      for (const name of streams(id)) expected.push(`${name} session.invalidated ${invalidated}`);
      for (const name of streams(id)) expected.push(`${name} close device_closed`);
    }
    expected.push('me devices.updated {"reason":"device_removed","deviceId":null}');
    assert.deepEqual(journal, expected);
  });

  test("one other device: devices.updated names it", async () => {
    const f = await family();
    assert.equal((await post(`/auth/me/devices/${f.a}/revoke`, f.token)).statusCode, 204);
    journal = [];
    assert.deepEqual(json(await post("/auth/me/devices/revoke-others", f.token)), { revokedCount: 1 });
    assert.deepEqual(journal, [
      `b session.invalidated ${invalidated}`,
      "b close device_closed",
      `me devices.updated ${removedOne(f.b)}`,
    ]);
  });

  test("no other device: revokedCount 0 and no event", async () => {
    const account = await createAccount(t.ctx);
    journal = [];
    watch(account.user.id, account.device.id, "me");
    const response = await post("/auth/me/devices/revoke-others", account.session.tokens.accessToken);
    assert.deepEqual(json(response), { revokedCount: 0 });
    assert.deepEqual(journal, []);
  });

  test("other users are never touched", async () => {
    const f = await family();
    const stranger = await createAccount(t.ctx);
    watch(stranger.user.id, stranger.device.id, "stranger");
    assert.deepEqual(json(await post("/auth/me/devices/revoke-others", f.token)), { revokedCount: 2 });
    assert.deepEqual(await deviceIds(stranger.user.id), [stranger.device.id]);
    assert.ok(journal.every((line) => !line.startsWith("stranger")));
  });
});
