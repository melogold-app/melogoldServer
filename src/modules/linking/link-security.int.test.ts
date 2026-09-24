/**
 * Security properties, on both dialects (API §4.6, DESIGN §4.10.5–4.10.6; PLAN T1.4 acceptance `link-security.int`):
 * `pollSecret` alone gates a session (the `linkToken` in a photographed QR code is not enough); a link already
 * claimed by one account refuses everybody else; a device that vanishes cancels the link it approves (never 404);
 * the device limit is enforced atomically before completion; `expired` is computed, never stored; a final status
 * erases the network hints and what the new device reported about itself.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createDevice, createSession, createAccount } from "../../test/factories.ts";
import { assertError, createTestApp } from "../../test/test-app.ts";
import type { TestApp } from "../../test/test-app.ts";
import {
  DESKTOP,
  approve,
  approveRaw,
  assertErased,
  createRequest,
  devicesOf,
  linkRow,
  poll,
  pollRaw,
  post,
  resolve,
} from "./linking.fixtures.test.ts";

let t: TestApp;

before(async () => {
  t = await createTestApp();
});

after(async () => {
  await t.close();
});

describe("only pollSecret gates a session; the linkToken in a photographed QR code is not enough", () => {
  test("a wrong pollSecret is link_not_found, even for a link that has already completed", async () => {
    const account = await createAccount(t.ctx);
    const created = await createRequest(t, DESKTOP);
    await resolve(t, account.session.tokens.accessToken, { linkToken: created.linkToken });
    const claimed = await pollRaw(t, created.pollSecret ?? assert.fail(), { knownStatus: "pending" });
    const verifyCode = claimed.json<{ verifyCode: string }>().verifyCode;
    await approve(t, account.session.tokens.accessToken, created.linkId, verifyCode);
    await poll(t, created.pollSecret ?? assert.fail(), { knownStatus: "claimed" });

    // Syntactically a valid pollSecret, built from the public linkToken, but not the one the server issued.
    const guessed = `mgps_${created.linkToken}`;
    assertError(await pollRaw(t, guessed, {}), 404, "link_not_found");
  });
});

describe("a link already claimed by one account refuses everybody else (API §4.6)", () => {
  test("resolve by another account after it is claimed: 409 link_already_claimed", async () => {
    const alice = await createAccount(t.ctx);
    const bob = await createAccount(t.ctx);
    const created = await createRequest(t, DESKTOP);
    await resolve(t, alice.session.tokens.accessToken, { linkToken: created.linkToken });

    const response = await post(
      t,
      "/auth/me/links/resolve",
      { linkToken: created.linkToken },
      { token: bob.session.tokens.accessToken },
    );
    assertError(response, 409, "link_already_claimed");
  });

  test("resolve by the same account's other device: 409; the approving device again is idempotent 200", async () => {
    const account = await createAccount(t.ctx);
    const otherDevice = await createDevice(t.db, account.user.id);
    const otherSession = await createSession(t.ctx, { userId: account.user.id, deviceId: otherDevice.id });
    const created = await createRequest(t, DESKTOP);
    await resolve(t, account.session.tokens.accessToken, { linkToken: created.linkToken });

    const response = await post(
      t,
      "/auth/me/links/resolve",
      { linkToken: created.linkToken },
      { token: otherSession.tokens.accessToken },
    );
    assertError(response, 409, "link_already_claimed");

    const again = await resolve(t, account.session.tokens.accessToken, { linkToken: created.linkToken });
    assert.equal(again.status, "claimed");
  });

  test("approve from another account's device: 404 link_not_found; from the same account's other device: 409 link_not_claimed", async () => {
    const account = await createAccount(t.ctx);
    const stranger = await createAccount(t.ctx);
    const otherDevice = await createDevice(t.db, account.user.id);
    const otherSession = await createSession(t.ctx, { userId: account.user.id, deviceId: otherDevice.id });
    const created = await createRequest(t, DESKTOP);
    await resolve(t, account.session.tokens.accessToken, { linkToken: created.linkToken });

    assertError(await approveRaw(t, stranger.session.tokens.accessToken, created.linkId, "00"), 404, "link_not_found");
    assertError(await approveRaw(t, otherSession.tokens.accessToken, created.linkId, "00"), 409, "link_not_claimed");
  });
});

describe("the approving device vanishes (DESIGN §4.10.3: computed from the row, not a separate write here)", () => {
  test("a device removed elsewhere cancels the link it approves; poll answers 410 link_cancelled, never 404", async () => {
    const account = await createAccount(t.ctx);
    const created = await createRequest(t, DESKTOP);
    await resolve(t, account.session.tokens.accessToken, { linkToken: created.linkToken });

    // As in another process (T1.5's convention): a direct DELETE, not the removal service.
    await t.db.write((q) => q.deleteFrom("devices").where("id", "=", account.device.id).execute());
    assert.equal((await linkRow(t, created.linkId)).approver_device_id, null, "ON DELETE SET NULL");

    assertError(await pollRaw(t, created.pollSecret ?? assert.fail(), {}), 410, "link_cancelled");
  });
});

describe("the device limit is enforced at two points (API §4.6 step 4, DESIGN §4.10.6)", () => {
  test("no free slot at approve time: 409 device_limit_reached, the link stays claimed", async () => {
    const limited = await createTestApp({ env: { MAX_DEVICES_PER_USER: "1" } });
    try {
      const account = await createAccount(limited.ctx); // already at the limit: 1 device, limit 1
      const created = await createRequest(limited, DESKTOP);
      await resolve(limited, account.session.tokens.accessToken, { linkToken: created.linkToken });
      const claimed = await pollRaw(limited, created.pollSecret ?? assert.fail(), { knownStatus: "pending" });
      const verifyCode = claimed.json<{ verifyCode: string }>().verifyCode;

      const response = await approveRaw(limited, account.session.tokens.accessToken, created.linkId, verifyCode);
      const body = assertError(response, 409, "device_limit_reached");
      assert.equal(body.deviceLimit, 1);
      assert.equal(body.deviceCount, 1);
      assert.equal((await linkRow(limited, created.linkId)).status, "claimed", "approve never ran its CAS");
    } finally {
      await limited.close();
    }
  });

  test("a slot filled after approval: poll answers 409 and the link stays approved; a freed slot completes it", async () => {
    const limited = await createTestApp({ env: { MAX_DEVICES_PER_USER: "2" } });
    try {
      const account = await createAccount(limited.ctx); // 1 device, room for one more
      const created = await createRequest(limited, DESKTOP);
      await resolve(limited, account.session.tokens.accessToken, { linkToken: created.linkToken });
      const claimed = await pollRaw(limited, created.pollSecret ?? assert.fail(), { knownStatus: "pending" });
      const verifyCode = claimed.json<{ verifyCode: string }>().verifyCode;
      await approve(limited, account.session.tokens.accessToken, created.linkId, verifyCode);

      // The slot fills only now, between approval and the new device's poll.
      const decoy = await createDevice(limited.db, account.user.id, { name: "Decoy" });

      const blocked = await pollRaw(limited, created.pollSecret ?? assert.fail(), { knownStatus: "claimed" });
      const body = assertError(blocked, 409, "device_limit_reached");
      assert.equal(body.deviceLimit, 2);
      assert.equal(body.deviceCount, 2);
      assert.equal((await linkRow(limited, created.linkId)).status, "approved", "the transaction rolled back");

      await limited.db.write((q) => q.deleteFrom("devices").where("id", "=", decoy.id).execute());

      const completed = await poll(limited, created.pollSecret ?? assert.fail(), { knownStatus: "claimed" });
      assert.equal(completed.status, "completed");
      assert.equal((await devicesOf(limited, account.user.id)).length, 2);
    } finally {
      await limited.close();
    }
  });
});

describe("expired is computed from expires_at, never stored (DESIGN §4.10.3)", () => {
  test("past expires_at: resolve and poll both answer link_expired; the stored status is never 'expired'", async () => {
    const account = await createAccount(t.ctx);
    const created = await createRequest(t, DESKTOP);
    t.clock.advance((t.ctx.env.LINK_TTL_SECONDS + 1) * 1000);

    const response = await post(
      t,
      "/auth/me/links/resolve",
      { linkToken: created.linkToken },
      { token: account.session.tokens.accessToken },
    );
    assertError(response, 410, "link_expired");
    assertError(await pollRaw(t, created.pollSecret ?? assert.fail(), {}), 410, "link_expired");
    assert.equal((await linkRow(t, created.linkId)).status, "pending", "expired is computed, never written");
  });
});

describe('a final status erases the network hints and the new device\'s report (API §4.6 "Прочее")', () => {
  test("denied and cancelled links erase creator_net, other_net and every claimant_* field", async () => {
    const account = await createAccount(t.ctx);

    const denied = await createRequest(t, DESKTOP);
    await resolve(t, account.session.tokens.accessToken, { linkToken: denied.linkToken });
    await post(t, `/auth/me/links/${denied.linkId}/deny`, {}, { token: account.session.tokens.accessToken });
    await assertErased(t, denied.linkId);

    const cancelled = await createRequest(t, DESKTOP);
    const response = await post(t, "/auth/link/cancel", { pollSecret: cancelled.pollSecret });
    assert.equal(response.statusCode, 204);
    await assertErased(t, cancelled.linkId);
  });
});
