/**
 * `auth-cleanup` (DESIGN §4.12), both dialects: stale refresh tokens (expired, rotated or revoked more than a day
 * ago), links expired more than an hour ago and throttle rows older than a day without an active lock go; everything
 * younger or still in use stays. Batches, and a stopped run deletes nothing.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "../../lib/clock.ts";
import { newId } from "../../lib/ids.ts";
import { hashToken } from "../../lib/tokens.ts";
import { createDevice, createUser } from "../../test/factories.ts";
import { createTestApp } from "../../test/test-app.ts";
import type { TestApp } from "../../test/test-app.ts";
import { TEST_DIALECT } from "../../test/test-db.ts";
import { AUTH_CLEANUP_JOB, authCleanupJob, runAuthCleanup } from "./auth-cleanup.job.ts";

let t: TestApp;

before(async () => {
  t = await createTestApp();
});

after(async () => {
  await t.close();
});

type TokenShape = Readonly<{
  expiresAt: number;
  rotatedGraceUntil?: number;
  revokedAt?: number;
}>;

/** A refresh token of a fresh device; returns its id. */
async function token(shape: TokenShape): Promise<string> {
  const now = t.clock.now();
  const user = await createUser(t.db, { now });
  const device = await createDevice(t.db, user.id, { now, lastSeenAt: now, linkedVia: "login" });
  const id = newId();
  await t.db.write((q) =>
    q
      .insertInto("refresh_tokens")
      .values({
        id,
        user_id: user.id,
        device_id: device.id,
        token_hash: hashToken(id),
        expires_at: shape.expiresAt,
        rotated_to_id: shape.rotatedGraceUntil === undefined ? null : newId(),
        rotation_grace_expires_at: shape.rotatedGraceUntil ?? null,
        revoked_at: shape.revokedAt ?? null,
        created_at: now - 40 * DAY_MS,
      })
      .execute(),
  );
  return id;
}

async function link(expiresAt: number): Promise<string> {
  const id = newId();
  await t.db.write((q) =>
    q
      .insertInto("device_links")
      .values({
        id,
        mode: "request",
        status: "pending",
        token_hash: hashToken(`t${id}`),
        code_hash: hashToken(`c${id}`),
        created_at: expiresAt - 10 * MINUTE_MS,
        expires_at: expiresAt,
      })
      .execute(),
  );
  return id;
}

async function throttle(updatedAt: number, lockedUntil: number | null): Promise<string> {
  const key = hashToken(newId());
  await t.db.write((q) =>
    q
      .insertInto("auth_throttle")
      .values({
        scope: "login",
        key_hash: key,
        failures: 6,
        window_start: updatedAt,
        locked_until: lockedUntil,
        updated_at: updatedAt,
      })
      .execute(),
  );
  return key;
}

async function tokenExists(id: string): Promise<boolean> {
  const row = await t.db.run((q) =>
    q.selectFrom("refresh_tokens").select("id").where("id", "=", id).executeTakeFirst(),
  );
  return row !== undefined;
}

async function linkExists(id: string): Promise<boolean> {
  const row = await t.db.run((q) => q.selectFrom("device_links").select("id").where("id", "=", id).executeTakeFirst());
  return row !== undefined;
}

async function throttleExists(key: string): Promise<boolean> {
  const row = await t.db.run((q) =>
    q.selectFrom("auth_throttle").select("key_hash").where("key_hash", "=", key).executeTakeFirst(),
  );
  return row !== undefined;
}

/** Runs the cleanup once so each test counts only its own rows. */
async function drain(): Promise<void> {
  await runAuthCleanup(t.ctx, { now: t.clock.now() });
}

describe(`auth-cleanup (${TEST_DIALECT})`, () => {
  test("refresh tokens: expired, rotated or revoked more than a day ago go; the rest stays", async () => {
    await drain();
    const now = t.clock.now();
    const gone = {
      expired: await token({ expiresAt: now - DAY_MS - MINUTE_MS }),
      rotated: await token({ expiresAt: now + 20 * DAY_MS, rotatedGraceUntil: now - DAY_MS - MINUTE_MS }),
      revoked: await token({ expiresAt: now + 20 * DAY_MS, revokedAt: now - 2 * DAY_MS }),
    };
    const kept = {
      live: await token({ expiresAt: now + 20 * DAY_MS }),
      expiredToday: await token({ expiresAt: now - 12 * HOUR_MS }),
      rotatedToday: await token({ expiresAt: now + 20 * DAY_MS, rotatedGraceUntil: now - 12 * HOUR_MS }),
      inGrace: await token({ expiresAt: now + 20 * DAY_MS, rotatedGraceUntil: now + MINUTE_MS }),
      revokedToday: await token({ expiresAt: now + 20 * DAY_MS, revokedAt: now - HOUR_MS }),
    };

    const report = await runAuthCleanup(t.ctx, { now });

    assert.equal(report.refreshTokens, 3);
    for (const [name, id] of Object.entries(gone)) assert.equal(await tokenExists(id), false, name);
    for (const [name, id] of Object.entries(kept)) assert.equal(await tokenExists(id), true, name);
  });

  test("links expired more than an hour ago go, whatever their status", async () => {
    await drain();
    const now = t.clock.now();
    const old = await link(now - HOUR_MS - MINUTE_MS);
    const recent = await link(now - 30 * MINUTE_MS);
    const open = await link(now + 5 * MINUTE_MS);

    const report = await runAuthCleanup(t.ctx, { now });

    assert.equal(report.links, 1);
    assert.equal(await linkExists(old), false);
    assert.equal(await linkExists(recent), true);
    assert.equal(await linkExists(open), true);
  });

  test("throttle rows older than a day go unless their lock still runs", async () => {
    await drain();
    const now = t.clock.now();
    const old = await throttle(now - 2 * DAY_MS, null);
    const oldLockOver = await throttle(now - 2 * DAY_MS, now - DAY_MS);
    const oldStillLocked = await throttle(now - 2 * DAY_MS, now + MINUTE_MS);
    const recent = await throttle(now - 12 * HOUR_MS, null);

    const report = await runAuthCleanup(t.ctx, { now });

    assert.equal(report.throttle, 2);
    assert.equal(await throttleExists(old), false);
    assert.equal(await throttleExists(oldLockOver), false);
    assert.equal(await throttleExists(oldStillLocked), true);
    assert.equal(await throttleExists(recent), true);
  });

  test("works in batches: more stale rows than one batch all go", async () => {
    await drain();
    const now = t.clock.now();
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(await token({ expiresAt: now - 2 * DAY_MS }));

    const report = await runAuthCleanup(t.ctx, { now, batchSize: 2 });

    assert.equal(report.refreshTokens, 5);
    for (const id of ids) assert.equal(await tokenExists(id), false);
  });

  test("a stopped run deletes nothing", async () => {
    await drain();
    const now = t.clock.now();
    const stale = await token({ expiresAt: now - 2 * DAY_MS });
    const controller = new AbortController();
    controller.abort();

    const report = await runAuthCleanup(t.ctx, { now, signal: controller.signal });

    assert.deepEqual({ ...report }, { refreshTokens: 0, links: 0, throttle: 0, inactiveDevices: 0 });
    assert.equal(await tokenExists(stale), true);
  });

  test("the job is hourly and cleans at its start time", async () => {
    await drain();
    const job = authCleanupJob(t.ctx);
    assert.equal(job.name, AUTH_CLEANUP_JOB);
    assert.deepEqual(job.schedules, [{ every: HOUR_MS }]);

    const now = t.clock.now();
    const stale = await token({ expiresAt: now - 2 * DAY_MS });
    const logged: object[] = [];
    await job.run({
      name: job.name,
      signal: new AbortController().signal,
      startedAt: now,
      log: {
        info: (details) => logged.push(details),
        warn: () => undefined,
        error: () => undefined,
      },
    });
    assert.equal(await tokenExists(stale), false);
    assert.equal(logged.length, 1);
  });
});
