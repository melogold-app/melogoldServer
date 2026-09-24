/**
 * Races and the repeated-poll window, on both dialects (DESIGN §4.10.6, m3; PLAN T1.4 acceptance `link-race.int`):
 * two concurrent polls of an approved link complete it exactly once and both get the session; the same poll repeats
 * the session for 60 s after `completed`, then answers `link_expired`. Also: claiming or resolving the same code
 * from two sides at once lets exactly one side win.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createAccount } from "../../test/factories.ts";
import { assertError, createTestApp } from "../../test/test-app.ts";
import type { TestApp } from "../../test/test-app.ts";
import {
  DESKTOP,
  PHONE,
  approve,
  claim,
  createInvite,
  createRequest,
  devicesOf,
  pollRaw,
  post,
  resolve,
} from "./linking.fixtures.test.ts";
import { COMPLETED_REPOLL_MS } from "./linking.service.ts";

let t: TestApp;

before(async () => {
  t = await createTestApp();
});

after(async () => {
  await t.close();
});

describe("two concurrent polls of an approved link complete it exactly once (DESIGN §4.10.6)", () => {
  test("both answers carry the same session; only one device is created", async () => {
    const account = await createAccount(t.ctx);
    const created = await createRequest(t, DESKTOP);
    await resolve(t, account.session.tokens.accessToken, { linkToken: created.linkToken });
    const claimedPoll = await pollRaw(t, created.pollSecret ?? assert.fail(), { knownStatus: "pending" });
    const verifyCode = claimedPoll.json<{ verifyCode: string }>().verifyCode;
    await approve(t, account.session.tokens.accessToken, created.linkId, verifyCode);

    const [first, second] = await Promise.all([
      pollRaw(t, created.pollSecret ?? assert.fail(), { knownStatus: "claimed" }),
      pollRaw(t, created.pollSecret ?? assert.fail(), { knownStatus: "claimed" }),
    ]);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(second.statusCode, 200, second.body);
    type Completed = { status: string; session: { tokens: { refreshToken: string }; device: { id: string } } };
    const [a, b] = [first.json(), second.json()] as [Completed, Completed];
    assert.equal(a.status, "completed");
    assert.equal(b.status, "completed");
    assert.equal(a.session.tokens.refreshToken, b.session.tokens.refreshToken);
    assert.equal(a.session.device.id, b.session.device.id);

    const devices = await devicesOf(t, account.user.id);
    assert.equal(devices.length, 2, "the approver's own device, plus exactly one linked device");
  });

  test("the same poll repeats the session for 60 s, then answers link_expired (m3)", async () => {
    const account = await createAccount(t.ctx);
    const created = await createInvite(t, account.session.tokens.accessToken);
    const claimed = await claim(t, { linkToken: created.linkToken }, PHONE);
    await approve(t, account.session.tokens.accessToken, created.linkId, claimed.verifyCode);

    const completed = await pollRaw(t, claimed.pollSecret, { knownStatus: "claimed" });
    assert.equal(completed.statusCode, 200);
    const firstSession = completed.json<{ session: { tokens: { refreshToken: string } } }>().session;

    t.clock.advance(COMPLETED_REPOLL_MS - 1);
    const stillRepeats = await pollRaw(t, claimed.pollSecret, {});
    assert.equal(stillRepeats.statusCode, 200, stillRepeats.body);
    const repeated = stillRepeats.json<{ status: string; session: { tokens: { refreshToken: string } } }>();
    assert.equal(repeated.status, "completed");
    assert.equal(repeated.session.tokens.refreshToken, firstSession.tokens.refreshToken);

    t.clock.advance(1);
    const tooLate = await pollRaw(t, claimed.pollSecret, {});
    assertError(tooLate, 410, "link_expired");
  });
});

describe("claiming or resolving the same code from two sides at once", () => {
  test("two devices claiming the same invite: one 200, the other 409 link_already_claimed", async () => {
    const account = await createAccount(t.ctx);
    const created = await createInvite(t, account.session.tokens.accessToken);

    const [first, second] = await Promise.all([
      post(t, "/auth/link/claim", { linkToken: created.linkToken, device: DESKTOP }),
      post(t, "/auth/link/claim", { linkToken: created.linkToken, device: PHONE }),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort();
    assert.deepEqual(statuses, [200, 409], `${first.body} / ${second.body}`);
    const loser = first.statusCode === 200 ? second : first;
    assertError(loser, 409, "link_already_claimed");
  });

  test("two accounts resolving the same request: one claims it, the other gets 409 link_already_claimed", async () => {
    const alice = await createAccount(t.ctx);
    const bob = await createAccount(t.ctx);
    const created = await createRequest(t, DESKTOP);

    const [first, second] = await Promise.all([
      post(t, "/auth/me/links/resolve", { linkToken: created.linkToken }, { token: alice.session.tokens.accessToken }),
      post(t, "/auth/me/links/resolve", { linkToken: created.linkToken }, { token: bob.session.tokens.accessToken }),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort();
    assert.deepEqual(statuses, [200, 409], `${first.body} / ${second.body}`);
    const loser = first.statusCode === 200 ? second : first;
    assertError(loser, 409, "link_already_claimed");
  });
});
