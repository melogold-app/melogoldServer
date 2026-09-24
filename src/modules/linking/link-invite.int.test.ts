/**
 * Mode `invite` end to end, on both dialects (API §4.6 "Режим invite", DESIGN §4.10; PLAN T1.4 acceptance
 * `link-invite.int`): a signed-in device shows a QR code, a new device claims it, the creator sees `link.updated`
 * over SSE and approves the number, and the new device polls until it gets a session.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { LinkClaimed, LinkCreated, LinkDetails } from "../../contract/linking.ts";
import { hashToken } from "../../lib/tokens.ts";
import { createAccount } from "../../test/factories.ts";
import { assertError, createTestApp } from "../../test/test-app.ts";
import type { TestApp } from "../../test/test-app.ts";
import {
  PHONE,
  approve,
  approveRaw,
  assertErased,
  card,
  captureLive,
  claim,
  createInvite,
  devicesOf,
  eventsOf,
  linkRow,
  poll,
  post,
} from "./linking.fixtures.test.ts";

let t: TestApp;

before(async () => {
  t = await createTestApp();
});

after(async () => {
  await t.close();
});

describe("mode invite: full path (API §4.6 step 1-4)", () => {
  test("createInvite → claim → SSE link.updated:claimed → card → approve → poll(claimed) → completed", async () => {
    const account = await createAccount(t.ctx);
    const events = captureLive(t, account.user.id, account.device.id);

    const created = await createInvite(t, account.session.tokens.accessToken);
    LinkCreated.parse(created);
    assert.equal(created.mode, "invite");
    assert.equal(created.pollSecret, null, "invite: pollSecret only reaches the claimer");
    assert.equal(created.serverId, t.ctx.serverId);

    const claimed = await claim(t, { linkToken: created.linkToken }, PHONE);
    LinkClaimed.parse(claimed);
    assert.equal(claimed.linkId, created.linkId);
    assert.equal(claimed.status, "claimed");
    assert.deepEqual(claimed.account, { login: account.user.login });
    assert.deepEqual(claimed.approverDevice, { name: account.device.name, platform: account.device.platform });
    assert.match(claimed.pollSecret, /^mgps_[A-Za-z0-9_-]{43}$/);
    assert.match(claimed.verifyCode, /^[0-9]{2}$/);

    assert.deepEqual(eventsOf(events), [
      { type: "link.updated", payload: { linkId: created.linkId, status: "claimed" } },
    ]);

    const details = await card(t, account.session.tokens.accessToken, created.linkId);
    LinkDetails.parse(details);
    assert.equal(details.status, "claimed");
    assert.deepEqual(details.device, {
      name: PHONE.name,
      platform: PHONE.platform,
      osVersion: PHONE.osVersion,
      model: null,
      clientVersion: null,
      alreadyLinked: false,
    });
    assert.equal(details.verifyChoices.length, 3);
    assert.ok(details.verifyChoices.includes(claimed.verifyCode));

    await approve(t, account.session.tokens.accessToken, created.linkId, claimed.verifyCode);

    const completed = await poll(t, claimed.pollSecret, { knownStatus: "claimed" });
    assert.equal(completed.status, "completed");
    assert.ok(completed.session);
    assert.equal(completed.session.device.linkedVia, "link");
    assert.equal(completed.session.device.linkedByDeviceId, account.device.id);

    const devices = await devicesOf(t, account.user.id);
    const linked = devices.find((row) => row.id !== account.device.id);
    assert.ok(linked);
    assert.equal(linked.hwid_hash, hashToken(PHONE.hwid));
    assert.equal(linked.linked_via, "link");

    // complete() publishes devices.updated before announcing the new status (DESIGN §4.10.6).
    assert.deepEqual(eventsOf(events), [
      { type: "link.updated", payload: { linkId: created.linkId, status: "claimed" } },
      { type: "devices.updated", payload: { reason: "device_added", deviceId: linked.id } },
      { type: "link.updated", payload: { linkId: created.linkId, status: "completed" } },
    ]);

    await assertErased(t, created.linkId);
  });

  test("a fourth active invite cancels the oldest", async () => {
    const account = await createAccount(t.ctx);
    // created_at must strictly increase: "oldest" is a tiebreak by id when two rows share a millisecond.
    const invites: Awaited<ReturnType<typeof createInvite>>[] = [];
    for (let index = 0; index < 3; index += 1) {
      if (index > 0) t.clock.advance(1000);
      invites.push(await createInvite(t, account.session.tokens.accessToken));
    }
    for (const invite of invites) {
      assert.equal((await linkRow(t, invite.linkId)).status, "pending");
    }
    t.clock.advance(1000);
    const fourth = await createInvite(t, account.session.tokens.accessToken);
    const oldest = await linkRow(t, invites[0]?.linkId ?? assert.fail());
    assert.equal(oldest.status, "cancelled");
    for (const invite of invites.slice(1)) {
      assert.equal((await linkRow(t, invite.linkId)).status, "pending");
    }
    assert.equal((await linkRow(t, fourth.linkId)).status, "pending");
  });

  test("the new device cancelling itself notifies the creator over SSE", async () => {
    const account = await createAccount(t.ctx);
    const events = captureLive(t, account.user.id, account.device.id);
    const created = await createInvite(t, account.session.tokens.accessToken);
    const claimed = await claim(t, { linkToken: created.linkToken }, PHONE);

    const cancelled = await post(t, "/auth/link/cancel", { pollSecret: claimed.pollSecret });
    assert.equal(cancelled.statusCode, 204);

    assert.deepEqual(eventsOf(events), [
      { type: "link.updated", payload: { linkId: created.linkId, status: "claimed" } },
      { type: "link.updated", payload: { linkId: created.linkId, status: "cancelled" } },
    ]);
    await assertErased(t, created.linkId);
  });

  test("the creator can cancel its own unclaimed invite; a second cancel is still 204", async () => {
    const account = await createAccount(t.ctx);
    const created = await createInvite(t, account.session.tokens.accessToken);
    const first = await post(
      t,
      `/auth/me/links/${created.linkId}/cancel`,
      {},
      { token: account.session.tokens.accessToken },
    );
    assert.equal(first.statusCode, 204);
    const second = await post(
      t,
      `/auth/me/links/${created.linkId}/cancel`,
      {},
      { token: account.session.tokens.accessToken },
    );
    assert.equal(second.statusCode, 204);
    assert.equal((await linkRow(t, created.linkId)).status, "cancelled");
  });

  test("approve of an invite before it is claimed is link_not_claimed", async () => {
    const account = await createAccount(t.ctx);
    const created = await createInvite(t, account.session.tokens.accessToken);
    const response = await approveRaw(t, account.session.tokens.accessToken, created.linkId, "00");
    assertError(response, 409, "link_not_claimed");
  });
});

describe("without SSE: polling the card every few seconds still works", () => {
  test("GET /auth/me/links/{id} reflects claim then approval without any live stream", async () => {
    const account = await createAccount(t.ctx);
    const created = await createInvite(t, account.session.tokens.accessToken);
    assert.equal((await card(t, account.session.tokens.accessToken, created.linkId)).status, "pending");
    const claimed = await claim(t, { linkToken: created.linkToken }, PHONE);
    assert.equal((await card(t, account.session.tokens.accessToken, created.linkId)).status, "claimed");
    await approve(t, account.session.tokens.accessToken, created.linkId, claimed.verifyCode);
    assert.equal((await card(t, account.session.tokens.accessToken, created.linkId)).status, "approved");
  });
});
