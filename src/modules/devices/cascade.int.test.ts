/**
 * Removing a device removes its refresh tokens (API §5, §9.2 `refresh_tokens.device_id … ON DELETE CASCADE`; PLAN T1.2
 * `cascade.int`), on SQLite (foreign keys on) and PostgreSQL alike: through revoke, through revoke-others and through a
 * plain `DELETE FROM devices` (the path of the CLI and of other processes). A refresh token of a removed device is
 * dead: its row is gone.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { DAY_MS } from "../../lib/clock.ts";
import { bearer, createAccount, createDevice, createSession } from "../../test/factories.ts";
import { createTestApp } from "../../test/test-app.ts";
import type { TestApp } from "../../test/test-app.ts";
import { TEST_DIALECT } from "../../test/test-db.ts";

let t: TestApp;

before(async () => {
  t = await createTestApp();
});

after(async () => {
  await t.close();
});

async function tokenDevices(userId: string): Promise<string[]> {
  const rows = await t.db.run((q) =>
    q.selectFrom("refresh_tokens").select("device_id").where("user_id", "=", userId).execute(),
  );
  return rows.map((row) => row.device_id).sort();
}

/** An account whose device `me` has one token, and two older devices with two tokens each. */
async function fixture() {
  const account = await createAccount(t.ctx);
  const userId = account.user.id;
  const others: string[] = [];
  for (const name of ["A", "B"]) {
    const device = await createDevice(t.db, userId, { now: t.clock.now() - DAY_MS, linkedVia: "login", name });
    await createSession(t.ctx, { userId, deviceId: device.id });
    await createSession(t.ctx, { userId, deviceId: device.id });
    others.push(device.id);
  }
  return { account, userId, me: account.device.id, others };
}

function post(url: string, token: string) {
  return t.app.inject({
    method: "POST",
    url,
    headers: { ...bearer(token), "content-type": "application/json" },
    payload: "{}",
  });
}

describe(`cascade (${TEST_DIALECT})`, () => {
  test("revoke deletes the device's tokens, and only them", async () => {
    const f = await fixture();
    const [a, b] = f.others as [string, string];
    assert.deepEqual(await tokenDevices(f.userId), [f.me, a, a, b, b].sort());
    const response = await post(`/auth/me/devices/${a}/revoke`, f.account.session.tokens.accessToken);
    assert.equal(response.statusCode, 204, response.body);
    assert.deepEqual(await tokenDevices(f.userId), [f.me, b, b].sort());
  });

  test("revoke-others deletes the tokens of every other device and keeps the caller's", async () => {
    const f = await fixture();
    const response = await post("/auth/me/devices/revoke-others", f.account.session.tokens.accessToken);
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(await tokenDevices(f.userId), [f.me]);
  });

  test("a plain DELETE FROM devices cascades to refresh_tokens on this dialect", async () => {
    const f = await fixture();
    const [a] = f.others as [string];
    const deleted = await t.db.write((q) => q.deleteFrom("devices").where("id", "=", a).executeTakeFirst());
    assert.equal(deleted.numDeletedRows, 1n);
    assert.ok(!(await tokenDevices(f.userId)).includes(a));
    const orphans = await t.db.run((q) =>
      q.selectFrom("refresh_tokens").select("id").where("device_id", "=", a).execute(),
    );
    assert.deepEqual(orphans, []);
  });
});
