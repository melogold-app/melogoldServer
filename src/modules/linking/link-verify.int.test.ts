/**
 * Number verification, on both dialects (DESIGN §4.10.4 "Сверка числа", API §4.6; PLAN T1.4 acceptance
 * `link-verify.int`): a wrong choice denies the link (`409 link_verify_mismatch`) and the waiting poll then answers
 * `403 link_denied`; an explicit deny behaves the same way; decisions already reached answer the same way again.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createAccount } from "../../test/factories.ts";
import { assertError, createTestApp } from "../../test/test-app.ts";
import type { TestApp } from "../../test/test-app.ts";
import {
  DESKTOP,
  approveRaw,
  createRequest,
  linkRow,
  pollRaw,
  post,
  resolve,
  wrongChoice,
} from "./linking.fixtures.test.ts";

let t: TestApp;

before(async () => {
  t = await createTestApp();
});

after(async () => {
  await t.close();
});

describe("a wrong verifyCode denies the link (DESIGN §4.10.4)", () => {
  test("approve with the wrong number: 409 link_verify_mismatch, then poll: 403 link_denied", async () => {
    const account = await createAccount(t.ctx);
    const created = await createRequest(t, DESKTOP);
    const details = await resolve(t, account.session.tokens.accessToken, { linkToken: created.linkToken });
    const claimed = await pollRaw(t, created.pollSecret ?? assert.fail(), { knownStatus: "pending" });
    const verifyCode = claimed.json<{ verifyCode: string }>().verifyCode;
    const wrong = wrongChoice(details, verifyCode);

    const denied = await approveRaw(t, account.session.tokens.accessToken, created.linkId, wrong);
    assertError(denied, 409, "link_verify_mismatch");
    assert.equal((await linkRow(t, created.linkId)).status, "denied");
    assert.equal((await linkRow(t, created.linkId)).deny_reason, "verify_mismatch");

    const polled = await pollRaw(t, created.pollSecret ?? assert.fail(), { knownStatus: "claimed" });
    assertError(polled, 403, "link_denied");
  });

  test("approving again after a mismatch answers link_verify_mismatch again, not link_not_claimed", async () => {
    const account = await createAccount(t.ctx);
    const created = await createRequest(t, DESKTOP);
    const details = await resolve(t, account.session.tokens.accessToken, { linkToken: created.linkToken });
    const claimed = await pollRaw(t, created.pollSecret ?? assert.fail(), { knownStatus: "pending" });
    const verifyCode = claimed.json<{ verifyCode: string }>().verifyCode;
    const wrong = wrongChoice(details, verifyCode);
    await approveRaw(t, account.session.tokens.accessToken, created.linkId, wrong);
    const again = await approveRaw(t, account.session.tokens.accessToken, created.linkId, wrong);
    assertError(again, 409, "link_verify_mismatch");
  });

  test("the right number approves; a repeated approve with the same number is idempotent", async () => {
    const account = await createAccount(t.ctx);
    const created = await createRequest(t, DESKTOP);
    await resolve(t, account.session.tokens.accessToken, { linkToken: created.linkToken });
    const claimed = await pollRaw(t, created.pollSecret ?? assert.fail(), { knownStatus: "pending" });
    const verifyCode = claimed.json<{ verifyCode: string }>().verifyCode;

    const first = await approveRaw(t, account.session.tokens.accessToken, created.linkId, verifyCode);
    assert.equal(first.statusCode, 200);
    assert.deepEqual(first.json(), { linkId: created.linkId, status: "approved" });

    const second = await approveRaw(t, account.session.tokens.accessToken, created.linkId, verifyCode);
    assert.equal(second.statusCode, 200);
    assert.deepEqual(second.json(), { linkId: created.linkId, status: "approved" });
  });
});

describe('explicit deny ("это не я")', () => {
  test("deny → LinkDecisionResponse denied; poll → 403 link_denied; deny again is the same 200", async () => {
    const account = await createAccount(t.ctx);
    const created = await createRequest(t, DESKTOP);
    await resolve(t, account.session.tokens.accessToken, { linkToken: created.linkToken });

    const denied = await post(
      t,
      `/auth/me/links/${created.linkId}/deny`,
      {},
      { token: account.session.tokens.accessToken },
    );
    assert.equal(denied.statusCode, 200);
    assert.deepEqual(denied.json(), { linkId: created.linkId, status: "denied" });

    const again = await post(
      t,
      `/auth/me/links/${created.linkId}/deny`,
      {},
      { token: account.session.tokens.accessToken },
    );
    assert.equal(again.statusCode, 200);
    assert.deepEqual(again.json(), { linkId: created.linkId, status: "denied" });

    const polled = await pollRaw(t, created.pollSecret ?? assert.fail(), {});
    assertError(polled, 403, "link_denied");
  });

  test("deny of a link that expired after being claimed answers 410 link_expired, not link_not_found", async () => {
    const account = await createAccount(t.ctx);
    const created = await createRequest(t, DESKTOP);
    await resolve(t, account.session.tokens.accessToken, { linkToken: created.linkToken });
    t.clock.advance((t.ctx.env.LINK_TTL_SECONDS + 1) * 1000);
    const response = await post(
      t,
      `/auth/me/links/${created.linkId}/deny`,
      {},
      { token: account.session.tokens.accessToken },
    );
    assertError(response, 410, "link_expired");
  });
});
