/**
 * Mode `request` end to end, on both dialects (API §4.6 "Режим request", DESIGN §4.10; PLAN T1.4 acceptance
 * `link-request.int`): a new device shows a QR code, a signed-in device resolves it and approves the number it
 * sees, and the new device polls until it gets a session.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { LinkCreated, LinkDetails, LinkPollResponse } from "../../contract/linking.ts";
import { SECOND_MS } from "../../lib/clock.ts";
import { formatIso } from "../../lib/time.ts";
import { hashToken, newLinkToken } from "../../lib/tokens.ts";
import { newId } from "../../lib/ids.ts";
import { createAccount } from "../../test/factories.ts";
import { assertError, createTestApp } from "../../test/test-app.ts";
import type { TestApp } from "../../test/test-app.ts";
import {
  DESKTOP,
  approve,
  assertErased,
  createRequest,
  devicesOf,
  poll,
  post,
  resolve,
} from "./linking.fixtures.test.ts";
import { insertLink } from "./linking.repository.ts";
import { createLinkingService, MAX_ACTIVE_REQUESTS_PER_NET, newUserCode } from "./linking.service.ts";

let t: TestApp;

before(async () => {
  t = await createTestApp();
});

after(async () => {
  await t.close();
});

describe("mode request: full path (API §4.6 step 1-5)", () => {
  test("createRequest → resolve → poll(pending) → approve → poll(claimed) → completed", async () => {
    const account = await createAccount(t.ctx);
    const net = "203.0.113.10";

    const created = await createRequest(t, DESKTOP, net);
    LinkCreated.parse(created);
    assert.equal(created.mode, "request");
    assert.equal(created.serverId, t.ctx.serverId);
    assert.match(created.linkToken, /^[A-Za-z0-9_-]{43}$/);
    assert.match(created.userCode, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    const pollSecret = created.pollSecret;
    assert.ok(pollSecret !== null, "mode=request gives a pollSecret");
    assert.equal(created.longPollSeconds, 25);
    assert.equal(created.expiresAt, formatIso(t.clock.now() + t.ctx.env.LINK_TTL_SECONDS * SECOND_MS));

    // The signed-in device (same network) opens the request by its QR token.
    const details = await resolve(t, account.session.tokens.accessToken, { linkToken: created.linkToken }, net);
    LinkDetails.parse(details);
    assert.equal(details.linkId, created.linkId);
    assert.equal(details.mode, "request");
    assert.equal(details.status, "claimed");
    assert.deepEqual(details.device, {
      name: DESKTOP.name,
      platform: DESKTOP.platform,
      osVersion: DESKTOP.osVersion,
      model: null,
      clientVersion: DESKTOP.clientVersion,
      alreadyLinked: false,
    });
    assert.equal(details.sameNetwork, true, "same net on both sides");
    assert.equal(details.verifyChoices.length, 3);
    assert.equal(new Set(details.verifyChoices).size, 3);

    // The new device polls: the status already differs from its knownStatus, so it is answered at once.
    const claimed = await poll(t, pollSecret, { knownStatus: "pending" });
    LinkPollResponse.parse(claimed);
    assert.equal(claimed.status, "claimed");
    assert.deepEqual(claimed.account, { login: account.user.login });
    assert.deepEqual(claimed.approverDevice, { name: account.device.name, platform: account.device.platform });
    assert.ok(claimed.verifyCode !== null);
    assert.ok(details.verifyChoices.includes(claimed.verifyCode), "the shown number is one of the three choices");
    assert.equal(claimed.session, null);

    await approve(t, account.session.tokens.accessToken, created.linkId, claimed.verifyCode);

    const completed = await poll(t, pollSecret, { knownStatus: "claimed" });
    LinkPollResponse.parse(completed);
    assert.equal(completed.status, "completed");
    assert.ok(completed.session);
    assert.equal(completed.session.user.login, account.user.login);
    assert.equal(completed.session.device.linkedVia, "link");
    assert.equal(completed.session.device.linkedByDeviceId, account.device.id);
    assert.equal(completed.session.device.name, DESKTOP.name);
    assert.equal(completed.session.device.isCurrent, true);
    assert.equal(completed.session.recoveryCode, null);
    assert.equal(completed.session.signedOutDevices, 0);

    // The device appears only now, created from what the new device reported.
    const devices = await devicesOf(t, account.user.id);
    assert.equal(devices.length, 2);
    const linked = devices.find((row) => row.id !== account.device.id);
    assert.ok(linked);
    assert.equal(linked.linked_via, "link");
    assert.equal(linked.linked_by_device_id, account.device.id);
    assert.equal(linked.hwid_hash, hashToken(DESKTOP.hwid));

    // m3: the same poll again within 60 s returns the same session.
    const again = await poll(t, pollSecret, {});
    assert.equal(again.status, "completed");
    assert.ok(again.session);
    assert.equal(again.session.tokens.refreshToken, completed.session.tokens.refreshToken);
    assert.equal(again.session.device.id, completed.session.device.id);

    await assertErased(t, created.linkId);
  });

  test("resolve also accepts userCode, loosely formatted", async () => {
    const account = await createAccount(t.ctx);
    const net = "203.0.113.11";
    const created = await createRequest(t, DESKTOP, net);
    const loose = created.userCode.toLowerCase().replace("-", " ");
    const details = await resolve(t, account.session.tokens.accessToken, { userCode: loose }, net);
    assert.equal(details.linkId, created.linkId);
    assert.equal(details.status, "claimed");
  });

  test("sameNetwork: true when equal, false when different, null with LINK_NETWORK_HINT=false", async () => {
    const account = await createAccount(t.ctx);
    const created = await createRequest(t, DESKTOP, "203.0.113.12");
    const details = await resolve(
      t,
      account.session.tokens.accessToken,
      { linkToken: created.linkToken },
      "203.0.113.99",
    );
    assert.equal(details.sameNetwork, false);

    const hintOff = await createTestApp({ env: { LINK_NETWORK_HINT: "false" } });
    try {
      const other = await createAccount(hintOff.ctx);
      const request = await createRequest(hintOff, DESKTOP, "203.0.113.13");
      const off = await resolve(
        hintOff,
        other.session.tokens.accessToken,
        { linkToken: request.linkToken },
        "203.0.113.13",
      );
      assert.equal(off.sameNetwork, null, "hint disabled, even on the same network");
    } finally {
      await hintOff.close();
    }
  });

  test("at most 20 active requests per network; the 21st is rate_limited with retryAfterSeconds", async () => {
    const net = "203.0.113.14";
    for (let index = 0; index < MAX_ACTIVE_REQUESTS_PER_NET; index += 1) {
      await createRequest(t, DESKTOP, net);
    }
    const response = await post(t, "/auth/link/requests", { device: DESKTOP }, { ip: net });
    const body = assertError(response, 429, "rate_limited");
    assert.ok(typeof body.retryAfterSeconds === "number" && body.retryAfterSeconds > 0, response.body);
  });
});

describe("secrets collide → the repository redraws (ON CONFLICT DO NOTHING RETURNING)", () => {
  test("createRequest retries once when the drawn linkToken is already taken", async () => {
    const now = t.clock.now();
    const taken = newLinkToken();
    await t.db.write((q) =>
      insertLink(q, {
        id: newId(),
        mode: "request",
        status: "pending",
        token_hash: hashToken(taken),
        code_hash: hashToken(newUserCode()),
        created_at: now,
        expires_at: now + 300_000,
      }),
    );
    let calls = 0;
    const service = createLinkingService(t.ctx, {
      secrets: { linkToken: () => (calls++ === 0 ? taken : newLinkToken()) },
    });
    const created = await service.createRequest({ ...DESKTOP, model: undefined }, "203.0.113.15");
    assert.equal(calls, 2, "the first draw collided, the second was used");
    assert.notEqual(created.linkToken, taken);
  });
});
