/**
 * `POST /auth/refresh`: rotation, races and theft (API §1.7, DESIGN §4.4, PLAN T1.1 acceptance `refresh-rotation.int`):
 * two parallel refreshes settle on one successor; a lost response (the successor never used) gets the same successor
 * again; a successor confirmed through an access token, then the predecessor presented again, is theft
 * (`refresh_token_reused`, the device is removed, live events fire in order); outside the grace window it is just
 * `invalid_refresh_token`; a wrong hwid is `device_mismatch` without touching anything. The restore-grace path
 * (DESIGN §3.15 item 5) and an unknown token id are covered too (`auth.repository.ts` queries, AGENTS.md rule 5).
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import type { LiveEvent } from "../../modules/live/live.events.ts";
import { bearer, createAccount, createDevice } from "../../test/factories.ts";
import type { TestAccount } from "../../test/factories.ts";
import { assertError, createTestApp, json } from "../../test/test-app.ts";
import type { TestApp } from "../../test/test-app.ts";
import { signRefreshToken } from "../../lib/tokens.ts";

type Recorder = { events: LiveEvent[]; closes: string[] };

/** Registers a fake stream for a device and records what the hub sends and how it closes it. */
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

function refreshBody(refreshToken: string, hwid: string, patch: Record<string, unknown> = {}) {
  return { refreshToken, device: { hwid, ...patch } };
}

describe("POST /auth/refresh: rotation", () => {
  let t: TestApp;
  let account: TestAccount;

  before(async () => {
    t = await createTestApp();
    account = await createAccount(t.ctx);
  });

  after(async () => {
    await t.close();
  });

  test("two parallel refreshes of the same current token settle on one, identical successor", async () => {
    const body = refreshBody(account.session.tokens.refreshToken, account.device.hwid);
    const [a, b] = await Promise.all([
      t.app.inject({ method: "POST", url: "/auth/refresh", payload: body }),
      t.app.inject({ method: "POST", url: "/auth/refresh", payload: body }),
    ]);
    assert.equal(a.statusCode, 200, a.body);
    assert.equal(b.statusCode, 200, b.body);
    assert.deepEqual(json(a).tokens, json(b).tokens, "both callers must see the same successor");

    const rows = await t.db.run((q) =>
      q.selectFrom("refresh_tokens").select("id").where("user_id", "=", account.user.id).execute(),
    );
    assert.equal(rows.length, 2, "the old token plus exactly one successor, never two");
  });

  test("a lost response: refreshing again with the (still unused) predecessor returns the same successor", async () => {
    const acc = await createAccount(t.ctx);
    const body = refreshBody(acc.session.tokens.refreshToken, acc.device.hwid);
    const first = await t.app.inject({ method: "POST", url: "/auth/refresh", payload: body });
    assert.equal(first.statusCode, 200, first.body);

    // The client never saw `first`'s answer (network dropped it) and retries with the same predecessor token.
    const retry = await t.app.inject({ method: "POST", url: "/auth/refresh", payload: body });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.deepEqual(json(retry).tokens, json(first).tokens);
  });
});

describe("POST /auth/refresh: theft (a confirmed successor, then the predecessor again)", () => {
  let t: TestApp;
  let account: TestAccount;
  let other: Awaited<ReturnType<typeof createDevice>>;

  before(async () => {
    t = await createTestApp();
    account = await createAccount(t.ctx);
    // A second device of the same user, to observe `devices.updated` sent to "the others".
    other = await createDevice(t.db, account.user.id, { name: "Second device" });
  });

  after(async () => {
    await t.close();
  });

  test("reuse removes the device: session.invalidated → close → devices.updated to the rest", async () => {
    const predecessor = account.session.tokens.refreshToken;
    const rotated = await t.app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: refreshBody(predecessor, account.device.hwid),
    });
    assert.equal(rotated.statusCode, 200, rotated.body);
    const successor = json(rotated).tokens as { accessToken: string; refreshToken: string };

    const removedWatch = watch(t, account.user.id, account.device.id);
    const otherWatch = watch(t, account.user.id, other.id);

    // Confirm the successor: the guard sets refresh_tokens.confirmed_at on the first request with rid=successor.
    const me = await t.app.inject({ method: "GET", url: "/auth/me", headers: bearer(successor.accessToken) });
    assert.equal(me.statusCode, 200, me.body);

    const reused = await t.app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: refreshBody(predecessor, account.device.hwid),
    });
    assertError(reused, 401, "refresh_token_reused");

    assert.deepEqual(
      removedWatch.events.map((event) => event.type),
      ["session.invalidated"],
    );
    assert.deepEqual(removedWatch.events[0]?.payload, { reason: "token_reuse", forceRelogin: true });
    assert.deepEqual(removedWatch.closes, ["device_closed"]);

    assert.deepEqual(
      otherWatch.events.map((event) => event.type),
      ["devices.updated"],
    );
    assert.deepEqual(otherWatch.events[0]?.payload, { reason: "device_removed", deviceId: account.device.id });

    const gone = await t.db.run((q) =>
      q.selectFrom("devices").select("id").where("id", "=", account.device.id).executeTakeFirst(),
    );
    assert.equal(gone, undefined, "the device row (and its tokens, by cascade) is gone");

    // The removed device's access token is now session_revoked, not merely stale.
    const meAgain = await t.app.inject({ method: "GET", url: "/auth/me", headers: bearer(successor.accessToken) });
    assertError(meAgain, 401, "session_revoked");
  });
});

describe("POST /auth/refresh: outside the grace window, hwid mismatch, unknown token", () => {
  let t: TestApp;

  before(async () => {
    t = await createTestApp({ env: { REFRESH_GRACE_SECONDS: "60" } });
  });

  after(async () => {
    await t.close();
  });

  test("a rotated predecessor presented after the grace window elapsed: invalid_refresh_token, not reused", async () => {
    const account = await createAccount(t.ctx);
    const predecessor = account.session.tokens.refreshToken;
    const rotated = await t.app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: refreshBody(predecessor, account.device.hwid),
    });
    assert.equal(rotated.statusCode, 200, rotated.body);

    t.clock.advance(61_000);
    const stale = await t.app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: refreshBody(predecessor, account.device.hwid),
    });
    assertError(stale, 401, "invalid_refresh_token");

    // Nothing was removed: the device (and its current, rotated-to token) still work.
    const row = await t.db.run((q) =>
      q.selectFrom("devices").select("id").where("id", "=", account.device.id).executeTakeFirst(),
    );
    assert.ok(row);
  });

  test("a wrong hwid: device_mismatch, and the current token is still usable afterwards (nothing removed)", async () => {
    const account = await createAccount(t.ctx);
    const wrongHwid = randomBytes(32).toString("hex");
    const mismatch = await t.app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: refreshBody(account.session.tokens.refreshToken, wrongHwid),
    });
    assertError(mismatch, 401, "device_mismatch");

    const row = await t.db.run((q) =>
      q.selectFrom("devices").select("id").where("id", "=", account.device.id).executeTakeFirst(),
    );
    assert.ok(row, "device_mismatch never removes the device");

    const retry = await t.app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: refreshBody(account.session.tokens.refreshToken, account.device.hwid),
    });
    assert.equal(retry.statusCode, 200, retry.body);
  });

  test("an unknown token id, no restore grace open: session_revoked", async () => {
    const account = await createAccount(t.ctx);
    const forged = signRefreshToken(
      {
        tid: "00000000-0000-4000-8000-000000000000",
        sub: account.user.id,
        did: account.device.id,
        expiresAt: t.clock.now() + 86_400_000,
      },
      t.keys.refreshToken,
    );
    const response = await t.app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: refreshBody(forged, account.device.hwid),
    });
    assertError(response, 401, "session_revoked");
  });

  // Order matters here: this test relies on no earlier test in this describe having set
  // `server_meta.restore_refresh_grace_until` (the next test does, for the whole rest of the app's lifetime).
  test("restore grace closed (no server_meta row): an orphaned token is session_revoked", async () => {
    const account = await createAccount(t.ctx);
    const orphanedToken = account.session.tokens.refreshToken;
    await t.db.write((q) => q.deleteFrom("refresh_tokens").where("device_id", "=", account.device.id).execute());

    const response = await t.app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: refreshBody(orphanedToken, account.device.hwid),
    });
    assertError(response, 401, "session_revoked");
  });

  test("restore grace open (DESIGN §3.15 item 5): an orphaned but authentic token of an existing device starts a new family", async () => {
    const account = await createAccount(t.ctx);
    const orphanedToken = account.session.tokens.refreshToken;
    // Simulate a restore from backup: this device's refresh_tokens row is gone, but the device itself survived.
    await t.db.write((q) => q.deleteFrom("refresh_tokens").where("device_id", "=", account.device.id).execute());
    await t.db.write((q) =>
      q
        .insertInto("server_meta")
        .values({ key: "restore_refresh_grace_until", value: String(t.clock.now() + 3_600_000) })
        .execute(),
    );

    const response = await t.app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: refreshBody(orphanedToken, account.device.hwid),
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = json(response) as { device: { id: string } };
    assert.equal(body.device.id, account.device.id, "the same device, a new token family");

    const rows = await t.db.run((q) =>
      q.selectFrom("refresh_tokens").select("id").where("device_id", "=", account.device.id).execute(),
    );
    assert.equal(rows.length, 1, "exactly the new family, nothing left over");
  });
});
