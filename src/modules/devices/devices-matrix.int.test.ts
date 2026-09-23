/**
 * The DESIGN §4.8 matrix over HTTP and the real database, both dialects (PLAN T1.2 `devices-matrix.int`): one test per
 * row of the table, read from `docs/DESIGN.md`, like `policy.test.ts` does for the pure functions.
 *
 * The device rows (rename, revoke, revoke-others) go through the routes of this module. The password rows of other
 * modules (`me/password`, `me/recovery-code`, `me/delete`) are checked through `passGate`, the enforcement those
 * routes share; link approval and recovery through the devices they create (`linked_via` `link` / `recovery`).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { argon2id, hash } from "argon2";
import type { LightMyRequestResponse } from "fastify";
import { AppError } from "../../http/errors.ts";
import { DAY_MS, HOUR_MS } from "../../lib/clock.ts";
import { bearer, createDevice, createSession, createUser } from "../../test/factories.ts";
import type { TestDevice, TestUser } from "../../test/factories.ts";
import { assertError, createTestApp, json } from "../../test/test-app.ts";
import type { TestApp } from "../../test/test-app.ts";
import { TEST_DIALECT } from "../../test/test-db.ts";
import {
  approveLinkGate,
  changePasswordDecision,
  deleteAccountGate,
  rotateRecoveryCodeGate,
} from "../security/policy.ts";
import { passGate } from "./reauth.ts";

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

type Account = Readonly<{
  user: TestUser;
  /** Registered 30 days ago: never recent, older than `me`. */
  old: TestDevice;
  /** The caller. */
  me: TestDevice;
  token: string;
}>;

/** A user with an old registered device and the calling device `me` (by default: a login one hour ago). */
async function account(
  me: Readonly<{ linkedVia?: "register" | "login" | "link" | "recovery"; ageMs?: number }> = {},
): Promise<Account> {
  const now = t.clock.now();
  const user = await createUser(t.db, { now: now - 60 * DAY_MS, passwordHash: PASSWORD_HASH });
  const old = await createDevice(t.db, user.id, { now: now - 30 * DAY_MS, linkedVia: "register", name: "Old phone" });
  const caller = await createDevice(t.db, user.id, {
    now: now - (me.ageMs ?? HOUR_MS),
    linkedVia: me.linkedVia ?? "login",
    name: "New laptop",
    ...(me.linkedVia === "link" ? { linkedByDeviceId: old.id } : {}),
  });
  return { user, old, me: caller, token: await token(user.id, caller.id) };
}

/** A fresh access token of the device at the current time of the clock. */
async function token(userId: string, deviceId: string): Promise<string> {
  const session = await createSession(t.ctx, { userId, deviceId });
  return session.tokens.accessToken;
}

function send(method: "PATCH" | "POST", url: string, accessToken: string, body: object) {
  return t.app.inject({
    method,
    url,
    headers: { ...bearer(accessToken), "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
}

const rename = (accessToken: string, deviceId: string, body: object) =>
  send("PATCH", `/auth/me/devices/${deviceId}`, accessToken, body);
const revoke = (accessToken: string, deviceId: string, body: object = {}) =>
  send("POST", `/auth/me/devices/${deviceId}/revoke`, accessToken, body);
const revokeOthers = (accessToken: string, body: object = {}) =>
  send("POST", "/auth/me/devices/revoke-others", accessToken, body);

async function deviceIds(userId: string): Promise<string[]> {
  const rows = await t.db.run((q) => q.selectFrom("devices").select("id").where("user_id", "=", userId).execute());
  return rows.map((row) => row.id).sort();
}

async function customName(deviceId: string): Promise<string | null | undefined> {
  const row = await t.db.run((q) =>
    q.selectFrom("devices").select("custom_name").where("id", "=", deviceId).executeTakeFirst(),
  );
  return row?.custom_name;
}

function assertOk(response: LightMyRequestResponse, status: number): void {
  assert.equal(response.statusCode, status, response.body);
}

async function rejects(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof AppError && error.code === code);
}

/** One scenario per row of the DESIGN §4.8 table, keyed by the text of its first column. */
const ROWS: ReadonlyMap<string, () => Promise<void>> = new Map([
  [
    "Переименовать своё устройство",
    async () => {
      // Always: a brand-new device, without a password; a wrong password is ignored (never verified).
      const a = await account({ ageMs: 1000 });
      const plain = await rename(a.token, a.me.id, { name: "Мой ноутбук" });
      assertOk(plain, 200);
      assert.equal(json(plain).name, "Мой ноутбук");
      const ignored = await rename(a.token, a.me.id, { name: "Ноутбук", password: WRONG });
      assertOk(ignored, 200);
      assert.equal(await customName(a.me.id), "Ноутбук");
      const link = await account({ linkedVia: "link", ageMs: 1000 });
      assertOk(await rename(link.token, link.me.id, { name: null }), 200);
    },
  ],
  [
    "Переименовать или отозвать чужое устройство `t`",
    async () => {
      // A new device (login, 1 h) acts on an older one: the password is required.
      const a = await account();
      assertError(await rename(a.token, a.old.id, { name: "Чужой" }), 403, "recent_device_restricted");
      assertError(await rename(a.token, a.old.id, { name: "Чужой", password: WRONG }), 403, "invalid_password");
      assert.equal(await customName(a.old.id), null, "nothing renamed");
      assertError(await revoke(a.token, a.old.id), 403, "recent_device_restricted");
      assertError(await revoke(a.token, a.old.id, { password: WRONG }), 403, "invalid_password");
      assert.ok((await deviceIds(a.user.id)).includes(a.old.id), "nothing revoked");
      const renamed = await rename(a.token, a.old.id, { name: "Чужой", password: PASSWORD });
      assertOk(renamed, 200);
      assert.equal(json(renamed).name, "Чужой");
      assert.equal(json(renamed).isCurrent, false);
      assertOk(await revoke(a.token, a.old.id, { password: PASSWORD }), 204);
      assert.deepEqual(await deviceIds(a.user.id), [a.me.id]);

      // A target that is not older than the caller: no password.
      const b = await account();
      const newer = await createDevice(t.db, b.user.id, { now: t.clock.now(), linkedVia: "login" });
      assertOk(await rename(b.token, newer.id, { name: "Новее" }), 200);
      assertOk(await revoke(b.token, newer.id), 204);

      // A caller that is not recent: registered or recovered just now, or logged in more than 24 h ago.
      for (const me of [
        { linkedVia: "register", ageMs: 1000 },
        { linkedVia: "recovery", ageMs: 1000 },
        { linkedVia: "login", ageMs: 25 * HOUR_MS },
      ] as const) {
        const c = await account(me);
        assertOk(await rename(c.token, c.old.id, { name: "Старый", password: WRONG }), 200);
        assertOk(await revoke(c.token, c.old.id), 204);
      }

      // The same caller stops being restricted when its 24 h end.
      const d = await account({ ageMs: HOUR_MS });
      assertError(await revoke(d.token, d.old.id), 403, "recent_device_restricted");
      t.clock.advance(23 * HOUR_MS);
      assertOk(await revoke(await token(d.user.id, d.me.id), d.old.id), 204);
    },
  ],
  [
    "`revoke-others`",
    async () => {
      // One restricted target refuses the whole call; nothing is removed on 403.
      const a = await account();
      const newer = await createDevice(t.db, a.user.id, { now: t.clock.now(), linkedVia: "login" });
      const all = [a.old.id, a.me.id, newer.id].sort();
      assertError(await revokeOthers(a.token), 403, "recent_device_restricted");
      assertError(await revokeOthers(a.token, { password: WRONG }), 403, "invalid_password");
      assert.deepEqual(await deviceIds(a.user.id), all);
      const done = await revokeOthers(a.token, { password: PASSWORD });
      assertOk(done, 200);
      assert.deepEqual(json(done), { revokedCount: 2 });
      assert.deepEqual(await deviceIds(a.user.id), [a.me.id]);

      // Only newer targets: no password.
      const b = await account();
      const c = await createDevice(t.db, b.user.id, { now: t.clock.now(), linkedVia: "login" });
      const bNewToken = await token(b.user.id, c.id);
      // `c` is the newest device, `b.me` and `b.old` are older than it.
      assertError(await revokeOthers(bNewToken), 403, "recent_device_restricted");
      await t.db.write((q) => q.deleteFrom("devices").where("id", "=", b.old.id).execute());
      assertError(await revokeOthers(bNewToken), 403, "recent_device_restricted");
      const fromOldest = await revokeOthers(b.token);
      assertOk(fromOldest, 200);
      assert.deepEqual(json(fromOldest), { revokedCount: 1 }, "b.me revokes only the newer c");

      // A caller that is not recent revokes everything without a password.
      const d = await account({ linkedVia: "register", ageMs: 1000 });
      await createDevice(t.db, d.user.id, { now: t.clock.now(), linkedVia: "link" });
      assert.deepEqual(json(await revokeOthers(d.token)), { revokedCount: 2 });
    },
  ],
  [
    "Смена пароля со старым",
    async () => {
      // Any signed-in device, recent included (no device input); a wrong old password is 403 invalid_password.
      const a = await account({ ageMs: 1000 });
      await rejects(passGate(t.ctx, a.user.id, changePasswordDecision(WRONG).gate), "invalid_password");
      assert.equal(await passGate(t.ctx, a.user.id, changePasswordDecision(PASSWORD).gate), true);
    },
  ],
  [
    "Смена пароля без старого",
    async () => {
      // Allowed from any signed-in device, without reauth (owner decision 2026-09-23).
      const a = await account({ ageMs: 1000 });
      const decision = changePasswordDecision(undefined);
      assert.equal(decision.notifyReason, "password_changed_without_old");
      assert.equal(await passGate(t.ctx, a.user.id, decision.gate), false);
    },
  ],
  [
    "Новый код восстановления",
    async () => {
      const a = await account({ linkedVia: "register", ageMs: 30 * DAY_MS });
      await rejects(passGate(t.ctx, a.user.id, rotateRecoveryCodeGate(WRONG)), "invalid_password");
      assert.equal(await passGate(t.ctx, a.user.id, rotateRecoveryCodeGate(PASSWORD)), true);
    },
  ],
  [
    "Удаление аккаунта",
    async () => {
      const a = await account({ linkedVia: "register", ageMs: 30 * DAY_MS });
      await rejects(passGate(t.ctx, a.user.id, deleteAccountGate(WRONG)), "invalid_password");
      assert.equal(await passGate(t.ctx, a.user.id, deleteAccountGate(PASSWORD)), true);
    },
  ],
  [
    "Одобрение привязки",
    async () => {
      // Any signed-in device approves ...
      assert.equal(await passGate(t.ctx, "not-used", approveLinkGate()), false);
      // ... and the device the link created is recent for 24 h: it is shown so and restricted.
      const a = await account({ linkedVia: "link", ageMs: HOUR_MS });
      const list = await t.app.inject({ method: "GET", url: "/auth/me/devices", headers: bearer(a.token) });
      const me = (json(list).devices as Record<string, unknown>[])[0];
      assert.ok(me);
      assert.equal(me.linkedVia, "link");
      assert.equal(me.linkedByDeviceId, a.old.id);
      assert.equal(me.recentUntil, new Date(t.clock.now() + 23 * HOUR_MS).toISOString());
      assertError(await revoke(a.token, a.old.id), 403, "recent_device_restricted");
      assertOk(await revoke(a.token, a.old.id, { password: PASSWORD }), 204);
    },
  ],
  [
    "Восстановление кодом",
    async () => {
      // The device of a recovery is never recent: it removes the others without a password.
      const a = await account({ linkedVia: "recovery", ageMs: 1000 });
      const list = await t.app.inject({ method: "GET", url: "/auth/me/devices", headers: bearer(a.token) });
      assert.equal((json(list).devices as Record<string, unknown>[])[0]?.recentUntil, null);
      assert.deepEqual(json(await revokeOthers(a.token)), { revokedCount: 1 });
    },
  ],
]);

function matrixRowsFromDesign(): string[] {
  const design = readFileSync(new URL("../../../docs/DESIGN.md", import.meta.url), "utf8");
  const from = design.indexOf("### 4.8");
  const to = design.indexOf("### 4.9", from);
  assert.ok(from >= 0 && to > from, "DESIGN §4.8 not found");
  return design
    .slice(from, to)
    .split("\n")
    .filter((line) => line.startsWith("|") && !/^\|\s*-/.test(line))
    .slice(1)
    .map((line) => (line.split("|")[1] ?? "").trim());
}

describe(`DESIGN §4.8 over HTTP (${TEST_DIALECT})`, () => {
  test("every row of the table has a scenario", () => {
    assert.deepEqual(matrixRowsFromDesign(), [...ROWS.keys()]);
  });

  for (const [row, scenario] of ROWS) test(row, scenario);

  test("NEW_DEVICE_RESTRICT_HOURS=0 turns the restriction off", async () => {
    const off = await createTestApp({ env: { NEW_DEVICE_RESTRICT_HOURS: "0" } });
    try {
      const now = off.clock.now();
      const user = await createUser(off.db, { now: now - DAY_MS, passwordHash: PASSWORD_HASH });
      const old = await createDevice(off.db, user.id, { now: now - DAY_MS, linkedVia: "register" });
      const me = await createDevice(off.db, user.id, { now, linkedVia: "login" });
      const session = await createSession(off.ctx, { userId: user.id, deviceId: me.id });
      const response = await off.app.inject({
        method: "POST",
        url: `/auth/me/devices/${old.id}/revoke`,
        headers: { ...bearer(session.tokens.accessToken), "content-type": "application/json" },
        payload: "{}",
      });
      assert.equal(response.statusCode, 204, response.body);
    } finally {
      await off.close();
    }
  });
});
