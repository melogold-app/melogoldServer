/**
 * `GET /auth/me/devices` and `PATCH /auth/me/devices/{deviceId}` (API §4.4), both dialects: the order and fields of the
 * list, `recentUntil`, `lastSyncAt` from `ctx.devices.touchLastSync`, `maxDevices`; renaming with the cleaned
 * `DeviceName`, back to the reported name with `null`, and `devices.updated{device_renamed}` to every device.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { LiveEvent } from "../../contract/live.ts";
import { AppError } from "../../http/errors.ts";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "../../lib/clock.ts";
import { newId } from "../../lib/ids.ts";
import { bearer, createAccount, createDevice } from "../../test/factories.ts";
import { assertError, createTestApp, json } from "../../test/test-app.ts";
import type { TestApp } from "../../test/test-app.ts";
import { TEST_DIALECT } from "../../test/test-db.ts";
import { listDevices, renameDevice } from "./devices.service.ts";

let t: TestApp;

before(async () => {
  t = await createTestApp();
});

after(async () => {
  await t.close();
});

const list = (token: string) => t.app.inject({ method: "GET", url: "/auth/me/devices", headers: bearer(token) });

function rename(token: string, deviceId: string, body: unknown) {
  return t.app.inject({
    method: "PATCH",
    url: `/auth/me/devices/${deviceId}`,
    headers: { ...bearer(token), "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
}

type Dto = Record<string, unknown>;

function devicesOf(body: Dto): Dto[] {
  return body.devices as Dto[];
}

describe(`GET /auth/me/devices (${TEST_DIALECT})`, () => {
  test("the current device first, then by lastSeenAt descending; every field of DeviceDto", async () => {
    const now = t.clock.now();
    const account = await createAccount(t.ctx, {
      device: { osVersion: "16", model: "Google Pixel 8", clientVersion: "1.3.0", lastSyncAt: now - MINUTE_MS },
    });
    const userId = account.user.id;
    const seenLong = await createDevice(t.db, userId, {
      now: now - 10 * DAY_MS,
      lastSeenAt: now - 5 * DAY_MS,
      linkedVia: "login",
      platform: "windows",
      name: "DESKTOP-7Q2",
    });
    const seenLately = await createDevice(t.db, userId, {
      now: now - HOUR_MS,
      lastSeenAt: now - MINUTE_MS,
      linkedVia: "link",
      linkedByDeviceId: account.device.id,
      platform: "macos",
      name: "MacBook Air",
      customName: "Работа",
    });
    await createAccount(t.ctx); // another user's devices never appear

    const response = await list(account.session.tokens.accessToken);
    assert.equal(response.statusCode, 200, response.body);
    const body = json(response);
    assert.equal(body.maxDevices, 20);
    const devices = devicesOf(body);
    assert.deepEqual(
      devices.map((device) => device.id),
      [account.device.id, seenLately.id, seenLong.id],
    );
    assert.deepEqual(devices[0], {
      id: account.device.id,
      name: "Google Pixel 8",
      reportedName: "Google Pixel 8",
      customName: null,
      platform: "android",
      osVersion: "16",
      model: "Google Pixel 8",
      clientVersion: "1.3.0",
      linkedVia: "register",
      linkedByDeviceId: null,
      createdAt: new Date(now).toISOString(),
      lastSeenAt: new Date(now).toISOString(),
      lastSyncAt: new Date(now - MINUTE_MS).toISOString(),
      recentUntil: null,
      isCurrent: true,
    });
    assert.deepEqual(
      { ...devices[1] },
      {
        id: seenLately.id,
        name: "Работа",
        reportedName: "MacBook Air",
        customName: "Работа",
        platform: "macos",
        osVersion: null,
        model: null,
        clientVersion: null,
        linkedVia: "link",
        linkedByDeviceId: account.device.id,
        createdAt: new Date(now - HOUR_MS).toISOString(),
        lastSeenAt: new Date(now - MINUTE_MS).toISOString(),
        lastSyncAt: null,
        recentUntil: new Date(now + 23 * HOUR_MS).toISOString(),
        isCurrent: false,
      },
    );
    assert.equal(devices[2]?.recentUntil, null, "a login device older than 24 h is not recent");
    assert.equal(response.headers["cache-control"], "no-store");
  });

  test("lastSyncAt follows ctx.devices.touchLastSync", async () => {
    const account = await createAccount(t.ctx);
    const token = account.session.tokens.accessToken;
    assert.equal(devicesOf(json(await list(token)))[0]?.lastSyncAt, null);
    t.clock.advance(MINUTE_MS);
    t.ctx.devices.touchLastSync(account.device.id);
    await t.ctx.devices.idle();
    assert.equal(devicesOf(json(await list(token)))[0]?.lastSyncAt, new Date(t.clock.now()).toISOString());
  });

  test("MAX_DEVICES_PER_USER=0: maxDevices is null", async () => {
    const unlimited = await createTestApp({ env: { MAX_DEVICES_PER_USER: "0" } });
    try {
      const account = await createAccount(unlimited.ctx);
      const response = await unlimited.app.inject({
        method: "GET",
        url: "/auth/me/devices",
        headers: bearer(account.session.tokens.accessToken),
      });
      assert.equal(json(response).maxDevices, null);
    } finally {
      await unlimited.close();
    }
  });
});

describe(`PATCH /auth/me/devices/{deviceId} (${TEST_DIALECT})`, () => {
  test("renames, cleans the name, returns the DeviceDto; null returns to the reported name", async () => {
    const account = await createAccount(t.ctx);
    const token = account.session.tokens.accessToken;
    const renamed = await rename(token, account.device.id, { name: "  Рабочий\u200E   ноутбук\u202E " });
    assert.equal(renamed.statusCode, 200, renamed.body);
    const dto = json(renamed);
    assert.equal(dto.name, "Рабочий ноутбук");
    assert.equal(dto.customName, "Рабочий ноутбук");
    assert.equal(dto.reportedName, "Google Pixel 8");
    assert.equal(dto.isCurrent, true);
    assert.equal(devicesOf(json(await list(token)))[0]?.name, "Рабочий ноутбук");

    const reset = json(await rename(token, account.device.id, { name: null }));
    assert.equal(reset.name, "Google Pixel 8");
    assert.equal(reset.customName, null);
  });

  test("devices.updated{device_renamed} goes to every device of the user, only when the name changed", async () => {
    const account = await createAccount(t.ctx);
    const other = await createDevice(t.db, account.user.id, { now: t.clock.now() - DAY_MS, linkedVia: "login" });
    const seen: string[] = [];
    for (const deviceId of [account.device.id, other.id]) {
      t.ctx.live.register({
        userId: account.user.id,
        deviceId,
        authVersion: 1,
        expiresAt: t.clock.now() + DAY_MS,
        send: (event: LiveEvent) => seen.push(`${deviceId} ${event.type} ${JSON.stringify(event.payload)}`),
        close: () => undefined,
      });
    }
    const token = account.session.tokens.accessToken;
    assert.equal((await rename(token, other.id, { name: "Ноутбук" })).statusCode, 200);
    const payload = JSON.stringify({ reason: "device_renamed", deviceId: other.id });
    assert.deepEqual(seen, [
      `${account.device.id} devices.updated ${payload}`,
      `${other.id} devices.updated ${payload}`,
    ]);
    seen.length = 0;
    assert.equal((await rename(token, other.id, { name: "Ноутбук" })).statusCode, 200);
    assert.deepEqual(seen, [], "the same name again changes nothing");
  });

  test("unknown or foreign device: 404 device_not_found", async () => {
    const account = await createAccount(t.ctx);
    const stranger = await createAccount(t.ctx);
    const token = account.session.tokens.accessToken;
    assertError(await rename(token, newId(), { name: "X" }), 404, "device_not_found");
    assertError(await rename(token, stranger.device.id, { name: "X" }), 404, "device_not_found");
    const row = await t.db.run((q) =>
      q.selectFrom("devices").select("custom_name").where("id", "=", stranger.device.id).executeTakeFirstOrThrow(),
    );
    assert.equal(row.custom_name, null);
  });

  test("an invalid name is 400 invalid_request: empty after cleaning, longer than 64, absent", async () => {
    const account = await createAccount(t.ctx);
    const token = account.session.tokens.accessToken;
    const id = account.device.id;
    const empty = assertError(await rename(token, id, { name: " \u200F\u0007 " }), 400, "invalid_request");
    assert.deepEqual(empty.issues, [{ path: "name", code: "too_small" }]);
    const long = assertError(await rename(token, id, { name: "я".repeat(65) }), 400, "invalid_request");
    assert.deepEqual(long.issues, [{ path: "name", code: "too_big" }]);
    assertError(await rename(token, id, {}), 400, "invalid_request");
    assert.equal((await rename(token, id, { name: "я".repeat(64) })).statusCode, 200);
  });

  test("the service answers 401 session_revoked when the caller's device is gone (removed after the guard)", async () => {
    const account = await createAccount(t.ctx);
    const other = await createDevice(t.db, account.user.id, { now: t.clock.now() - DAY_MS, linkedVia: "login" });
    await t.db.write((q) => q.deleteFrom("devices").where("id", "=", account.device.id).execute());
    const caller = { userId: account.user.id, deviceId: account.device.id };
    const revoked = (error: unknown) => error instanceof AppError && error.code === "session_revoked";
    await assert.rejects(listDevices(t.ctx, caller), revoked);
    await assert.rejects(renameDevice(t.ctx, caller, { deviceId: other.id, name: "X", password: undefined }), revoked);
  });
});
