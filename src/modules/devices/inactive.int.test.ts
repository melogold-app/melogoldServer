/**
 * Cleanup of inactive devices (DESIGN §4.6, §4.12), both dialects: a device unseen for `DEVICE_INACTIVE_DAYS` and
 * without a live refresh token is removed through `removeDevicesInTx` (tokens by cascade, its unfinished links
 * cancelled), in batches; no SSE event is published (API §5), a stream the device still holds is closed.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { DAY_MS, HOUR_MS } from "../../lib/clock.ts";
import { newId } from "../../lib/ids.ts";
import { hashToken } from "../../lib/tokens.ts";
import { createDevice, createUser } from "../../test/factories.ts";
import type { TestUser } from "../../test/factories.ts";
import { createTestApp } from "../../test/test-app.ts";
import type { TestApp } from "../../test/test-app.ts";
import { TEST_DIALECT } from "../../test/test-db.ts";
import { findInactiveDevices, stillInactiveDevices } from "./devices.repository.ts";
import { inactiveCriteria, removeInactiveDevices } from "./inactive.job.ts";

const INACTIVE_DAYS = 180;

let t: TestApp;

before(async () => {
  t = await createTestApp({ env: { DEVICE_INACTIVE_DAYS: String(INACTIVE_DAYS) } });
});

after(async () => {
  await t.close();
});

type TokenState = "live" | "expired" | "revoked" | "rotated" | "none";

/** A device of `user` last seen `daysAgo` days ago, with one refresh token in the given state. */
async function device(user: TestUser, daysAgo: number, token: TokenState): Promise<string> {
  const now = t.clock.now();
  const seen = now - daysAgo * DAY_MS;
  const created = await createDevice(t.db, user.id, { now: seen - DAY_MS, lastSeenAt: seen, linkedVia: "login" });
  if (token !== "none") {
    await t.db.write((q) =>
      q
        .insertInto("refresh_tokens")
        .values({
          id: newId(),
          user_id: user.id,
          device_id: created.id,
          token_hash: hashToken(newId()),
          expires_at: token === "expired" ? now - HOUR_MS : now + 30 * DAY_MS,
          revoked_at: token === "revoked" ? now - DAY_MS : null,
          rotated_to_id: token === "rotated" ? newId() : null,
          created_at: seen,
        })
        .execute(),
    );
  }
  return created.id;
}

async function exists(deviceId: string): Promise<boolean> {
  const row = await t.db.run((q) => q.selectFrom("devices").select("id").where("id", "=", deviceId).executeTakeFirst());
  return row !== undefined;
}

/** Removes every inactive device left over by earlier tests, so each test counts only its own. */
async function drain(): Promise<void> {
  await removeInactiveDevices(t.ctx);
}

describe(`inactive devices (${TEST_DIALECT})`, () => {
  test("removes a device unseen for DEVICE_INACTIVE_DAYS without a live refresh token, keeps the others", async () => {
    await drain();
    const user = await createUser(t.db, { now: t.clock.now() - 400 * DAY_MS });
    const gone = {
      noToken: await device(user, INACTIVE_DAYS + 1, "none"),
      expired: await device(user, INACTIVE_DAYS + 1, "expired"),
      revoked: await device(user, INACTIVE_DAYS + 1, "revoked"),
      rotated: await device(user, INACTIVE_DAYS + 1, "rotated"),
    };
    const kept = {
      liveToken: await device(user, INACTIVE_DAYS + 30, "live"),
      recent: await device(user, INACTIVE_DAYS - 1, "none"),
    };
    assert.equal(await removeInactiveDevices(t.ctx), 4);
    for (const [name, id] of Object.entries(gone)) assert.equal(await exists(id), false, name);
    for (const [name, id] of Object.entries(kept)) assert.equal(await exists(id), true, name);
    const tokens = await t.db.run((q) =>
      q.selectFrom("refresh_tokens").select("device_id").where("device_id", "in", Object.values(gone)).execute(),
    );
    assert.deepEqual(tokens, [], "tokens go by cascade");
  });

  test("the boundary: exactly DEVICE_INACTIVE_DAYS ago is still kept", async () => {
    await drain();
    const user = await createUser(t.db, { now: t.clock.now() - 400 * DAY_MS });
    const edge = await device(user, INACTIVE_DAYS, "none");
    assert.equal(await removeInactiveDevices(t.ctx), 0);
    assert.equal(await exists(edge), true);
  });

  test("its unfinished links are cancelled; no SSE event, its own stream is closed", async () => {
    await drain();
    const user = await createUser(t.db, { now: t.clock.now() - 400 * DAY_MS });
    const stale = await device(user, INACTIVE_DAYS + 1, "none");
    const active = await device(user, 0, "live");
    const linkId = newId();
    await t.db.write((q) =>
      q
        .insertInto("device_links")
        .values({
          id: linkId,
          mode: "invite",
          status: "pending",
          token_hash: hashToken(`t${linkId}`),
          code_hash: hashToken(`c${linkId}`),
          user_id: user.id,
          approver_device_id: stale,
          created_at: t.clock.now(),
          expires_at: t.clock.now() + 300_000,
        })
        .execute(),
    );
    const journal: string[] = [];
    for (const [name, deviceId] of [
      ["stale", stale],
      ["active", active],
    ] as const) {
      t.ctx.live.register({
        userId: user.id,
        deviceId,
        authVersion: 1,
        expiresAt: t.clock.now() + DAY_MS,
        send: (event) => journal.push(`${name} ${event.type}`),
        close: (reason) => journal.push(`${name} close ${reason}`),
      });
    }
    assert.equal(await removeInactiveDevices(t.ctx), 1);
    assert.deepEqual(journal, ["stale close device_closed"]);
    const link = await t.db.run((q) =>
      q.selectFrom("device_links").select("status").where("id", "=", linkId).executeTakeFirstOrThrow(),
    );
    assert.equal(link.status, "cancelled");
  });

  test("works in batches across users until nothing is left", async () => {
    await drain();
    const ids: string[] = [];
    for (let u = 0; u < 3; u++) {
      const user = await createUser(t.db, { now: t.clock.now() - 400 * DAY_MS });
      for (let d = 0; d < 3; d++) ids.push(await device(user, INACTIVE_DAYS + 1 + d, "none"));
    }
    let pauses = 0;
    const removed = await removeInactiveDevices(t.ctx, {
      batchSize: 2,
      yieldBetween: () => {
        pauses += 1;
        return Promise.resolve();
      },
    });
    assert.equal(removed, 9);
    assert.equal(pauses, 4, "batches of 2, 2, 2, 2 and a last one of 1");
    for (const id of ids) assert.equal(await exists(id), false);
  });

  test("an aborted signal stops before any work", async () => {
    await drain();
    const user = await createUser(t.db, { now: t.clock.now() - 400 * DAY_MS });
    const stale = await device(user, INACTIVE_DAYS + 1, "none");
    const controller = new AbortController();
    controller.abort();
    assert.equal(await removeInactiveDevices(t.ctx, { signal: controller.signal }), 0);
    assert.equal(await exists(stale), true);
  });

  test("the re-check under lockUser skips a device that became active after it was found", async () => {
    await drain();
    const user = await createUser(t.db, { now: t.clock.now() - 400 * DAY_MS });
    const stale = await device(user, INACTIVE_DAYS + 1, "none");
    const criteria = inactiveCriteria(t.clock.now(), INACTIVE_DAYS);
    const found = await t.db.run((q) => findInactiveDevices(q, criteria, 10));
    assert.deepEqual(found, [{ id: stale, userId: user.id }]);
    // A login reused the device in between.
    await t.db.write((q) =>
      q.updateTable("devices").set({ last_seen_at: t.clock.now() }).where("id", "=", stale).execute(),
    );
    assert.deepEqual(await t.db.run((q) => stillInactiveDevices(q, user.id, [stale], criteria)), []);
    assert.equal(await removeInactiveDevices(t.ctx), 0);
    assert.equal(await exists(stale), true);
  });
});
