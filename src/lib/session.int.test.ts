/**
 * `issueSession` / `tokensForRefreshRow` on the migrated schema, both dialects (API §1.7, DESIGN §4.3–4.4).
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Kysely } from "kysely";
import type { Database, Db } from "../db/index.ts";
import { TxRuleError } from "../db/tx.ts";
import { TEST_DIALECT, createMigratedTestDatabase } from "../test/test-db.ts";
import type { TestDatabase } from "../test/test-db.ts";
import { DAY_MS } from "./clock.ts";
import { newId } from "./ids.ts";
import { issueSession, sessionConfig, tokensForRefreshRow } from "./session.ts";
import { parseIso } from "./time.ts";
import { hashToken, parseRefreshToken, refreshTokenMatchesRow, verifyAccessToken } from "./tokens.ts";

const NOW = Date.UTC(2026, 8, 23, 10, 0, 0, 250);
const config = sessionConfig(
  { ACCESS_TOKEN_TTL_SECONDS: 900, REFRESH_TOKEN_TTL_DAYS: 90 },
  { jwtAccess: Buffer.alloc(32, 1), refreshToken: Buffer.alloc(32, 2) },
);

let database: TestDatabase;
let db: Db;

before(async () => {
  ({ database, db } = await createMigratedTestDatabase());
});

after(async () => {
  await db.destroy();
  await database.cleanup();
});

async function insertUserWithDevice(q: Kysely<Database>, userId: string, deviceId: string): Promise<void> {
  await q
    .insertInto("users")
    .values({
      id: userId,
      login: `u${userId.slice(0, 8)}`,
      password_hash: "$argon2id$stub",
      password_changed_at: NOW,
      recovery_code_hash: "0".repeat(64),
      recovery_code_created_at: NOW,
      created_at: NOW,
      updated_at: NOW,
    })
    .execute();
  await insertDevice(q, userId, deviceId);
}

async function insertDevice(q: Kysely<Database>, userId: string, deviceId: string): Promise<void> {
  await q
    .insertInto("devices")
    .values({
      id: deviceId,
      user_id: userId,
      hwid_hash: hashToken(deviceId),
      reported_name: "Test device",
      platform: "android",
      linked_via: "register",
      created_at: NOW,
      last_seen_at: NOW,
    })
    .execute();
}

describe(`issueSession (${TEST_DIALECT})`, () => {
  test("inserts the refresh row and returns a pair whose access token carries rid", async () => {
    const userId = newId();
    const deviceId = newId();
    const session = await db.write(async (q) => {
      await insertUserWithDevice(q, userId, deviceId);
      return issueSession(q, { userId, deviceId, authVersion: 1, now: NOW }, config);
    });

    const row = await db.run((q) =>
      q.selectFrom("refresh_tokens").selectAll().where("id", "=", session.refreshId).executeTakeFirstOrThrow(),
    );
    assert.equal(row.user_id, userId);
    assert.equal(row.device_id, deviceId);
    assert.equal(row.token_hash, hashToken(session.tokens.refreshToken));
    assert.equal(row.expires_at, NOW + 90 * DAY_MS);
    assert.equal(row.created_at, NOW);
    assert.equal(row.rotated_to_id, null);
    assert.equal(row.revoked_at, null);
    assert.equal(row.confirmed_at, null);

    const refresh = parseRefreshToken(session.tokens.refreshToken, config.refreshKey);
    assert.ok(refresh);
    assert.equal(refreshTokenMatchesRow(refresh, row), true);

    const access = verifyAccessToken(session.tokens.accessToken, config.accessKey, NOW);
    assert.ok(access.ok);
    assert.equal(access.claims.sub, userId);
    assert.equal(access.claims.did, deviceId);
    assert.equal(access.claims.av, 1);
    assert.equal(access.claims.rid, session.refreshId);

    assert.equal(session.tokens.accessTokenExpiresAt, "2026-09-23T10:15:00.000Z");
    assert.equal(parseIso(session.tokens.accessTokenExpiresAt), session.accessTokenExpiresAtMs);
    assert.equal(session.tokens.refreshTokenExpiresAt, "2026-12-22T10:00:00.250Z");
    assert.equal(session.refreshTokenExpiresAtMs, row.expires_at);
  });

  test("replaceDeviceTokens starts a new family for that device only; refreshId can be chosen", async () => {
    const userId = newId();
    const phone = newId();
    const laptop = newId();
    const first = await db.write(async (q) => {
      await insertUserWithDevice(q, userId, phone);
      await insertDevice(q, userId, laptop);
      await issueSession(q, { userId, deviceId: laptop, authVersion: 1, now: NOW }, config);
      return issueSession(q, { userId, deviceId: phone, authVersion: 1, now: NOW }, config);
    });
    const chosen = newId();
    const second = await db.write((q) =>
      issueSession(
        q,
        { userId, deviceId: phone, authVersion: 2, now: NOW + 1000, replaceDeviceTokens: true, refreshId: chosen },
        config,
      ),
    );
    assert.equal(second.refreshId, chosen);
    const rows = await db.run((q) =>
      q.selectFrom("refresh_tokens").select(["id", "device_id"]).where("user_id", "=", userId).orderBy("id").execute(),
    );
    const byDevice = (deviceId: string) => rows.filter((row) => row.device_id === deviceId).map((row) => row.id);
    assert.deepEqual(byDevice(phone), [chosen]);
    assert.equal(byDevice(laptop).length, 1);
    assert.ok(!rows.some((row) => row.id === first.refreshId));
  });

  test("refuses to run outside db.write", async () => {
    const input = { userId: newId(), deviceId: newId(), authVersion: 1, now: NOW };
    await assert.rejects(
      db.read((q) => issueSession(q, input, config)),
      TxRuleError,
    );
    await assert.rejects(
      db.run((q) => issueSession(q, input, config)),
      TxRuleError,
    );
  });

  test("tokensForRefreshRow re-signs the same refresh token and a new access token", async () => {
    const userId = newId();
    const deviceId = newId();
    const issued = await db.write(async (q) => {
      await insertUserWithDevice(q, userId, deviceId);
      return issueSession(q, { userId, deviceId, authVersion: 1, now: NOW }, config);
    });
    const row = await db.run((q) =>
      q
        .selectFrom("refresh_tokens")
        .select(["id", "user_id", "device_id", "expires_at", "token_hash"])
        .where("id", "=", issued.refreshId)
        .executeTakeFirstOrThrow(),
    );
    const later = NOW + 60_000;
    const again = tokensForRefreshRow(row, 5, config, later);
    assert.equal(again.tokens.refreshToken, issued.tokens.refreshToken);
    assert.equal(hashToken(again.tokens.refreshToken), row.token_hash);
    assert.equal(again.tokens.refreshTokenExpiresAt, issued.tokens.refreshTokenExpiresAt);
    const access = verifyAccessToken(again.tokens.accessToken, config.accessKey, later);
    assert.ok(access.ok);
    assert.equal(access.claims.rid, row.id);
    assert.equal(access.claims.av, 5);
    assert.equal(again.accessTokenExpiresAtMs, Math.floor(later / 1000) * 1000 + 900_000);
  });
});
