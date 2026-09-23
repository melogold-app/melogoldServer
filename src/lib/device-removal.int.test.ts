/**
 * `removeDevicesInTx` / `removeAllDevicesInTx` on the migrated schema, both dialects (DESIGN §4.6): unfinished links
 * approved by a removed device are cancelled, tokens go by cascade, other users are never touched.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Kysely } from "kysely";
import type { Database, Db } from "../db/index.ts";
import { TxRuleError } from "../db/tx.ts";
import { TEST_DIALECT, createMigratedTestDatabase } from "../test/test-db.ts";
import type { TestDatabase } from "../test/test-db.ts";
import { removeAllDevicesInTx, removeDevicesInTx } from "./device-removal.ts";
import { newId } from "./ids.ts";
import { hashToken } from "./tokens.ts";

const NOW = Date.UTC(2026, 8, 23, 10, 0, 0);

let database: TestDatabase;
let db: Db;

before(async () => {
  ({ database, db } = await createMigratedTestDatabase());
});

after(async () => {
  await db.destroy();
  await database.cleanup();
});

async function insertUser(q: Kysely<Database>, userId: string): Promise<void> {
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
}

async function insertDevice(q: Kysely<Database>, userId: string, deviceId: string): Promise<void> {
  await q
    .insertInto("devices")
    .values({
      id: deviceId,
      user_id: userId,
      hwid_hash: hashToken(deviceId),
      reported_name: "Device",
      platform: "linux",
      linked_via: "login",
      created_at: NOW,
      last_seen_at: NOW,
    })
    .execute();
  await q
    .insertInto("refresh_tokens")
    .values({
      id: newId(),
      user_id: userId,
      device_id: deviceId,
      token_hash: hashToken(newId()),
      expires_at: NOW + 1000,
      created_at: NOW,
    })
    .execute();
}

async function insertLink(
  q: Kysely<Database>,
  userId: string,
  approverDeviceId: string,
  status: string,
): Promise<string> {
  const id = newId();
  await q
    .insertInto("device_links")
    .values({
      id,
      mode: "invite",
      status,
      token_hash: hashToken(`t${id}`),
      code_hash: hashToken(`c${id}`),
      user_id: userId,
      approver_device_id: approverDeviceId,
      creator_net: "203.0.113.7",
      other_net: "2001:db8:1200::",
      created_at: NOW,
      expires_at: NOW + 300_000,
    })
    .execute();
  return id;
}

type Fixture = { userId: string; devices: string[]; links: Record<string, string> };

/** A user with three devices; device 0 approves one link in every status, device 1 has one pending link. */
async function fixture(): Promise<Fixture> {
  const userId = newId();
  const devices = [newId(), newId(), newId()];
  const links: Record<string, string> = {};
  await db.write(async (q) => {
    await insertUser(q, userId);
    for (const deviceId of devices) await insertDevice(q, userId, deviceId);
    for (const status of ["pending", "claimed", "approved", "completed", "denied", "cancelled"]) {
      links[status] = await insertLink(q, userId, devices[0]!, status);
    }
    links.other = await insertLink(q, userId, devices[1]!, "pending");
  });
  return { userId, devices, links };
}

async function linkState(id: string) {
  return db.run((q) =>
    q
      .selectFrom("device_links")
      .select(["status", "creator_net", "other_net", "approver_device_id"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow(),
  );
}

async function deviceIds(userId: string): Promise<string[]> {
  const rows = await db.run((q) => q.selectFrom("devices").select("id").where("user_id", "=", userId).execute());
  return rows.map((row) => row.id).sort();
}

async function tokenDevices(userId: string): Promise<string[]> {
  const rows = await db.run((q) =>
    q.selectFrom("refresh_tokens").select("device_id").where("user_id", "=", userId).execute(),
  );
  return rows.map((row) => row.device_id).sort();
}

describe(`removeDevicesInTx (${TEST_DIALECT})`, () => {
  test("deletes the devices, cascades their tokens, cancels their unfinished links", async () => {
    const { userId, devices, links } = await fixture();
    const removed = await db.write((q) => removeDevicesInTx(q, userId, [devices[0]!], "device_revoked"));
    assert.deepEqual(removed, { userId, deviceIds: [devices[0]], reason: "device_revoked" });
    assert.deepEqual(await deviceIds(userId), [devices[1]!, devices[2]!].sort());
    assert.deepEqual(await tokenDevices(userId), [devices[1]!, devices[2]!].sort());

    for (const status of ["pending", "claimed", "approved"]) {
      const state = await linkState(links[status]!);
      assert.equal(state.status, "cancelled", status);
      assert.equal(state.creator_net, null);
      assert.equal(state.other_net, null);
      assert.equal(state.approver_device_id, null, "ON DELETE SET NULL");
    }
    for (const status of ["completed", "denied", "cancelled"]) {
      const state = await linkState(links[status]!);
      assert.equal(state.status, status, `${status} stays final`);
      assert.equal(state.creator_net, "203.0.113.7", "final links are not rewritten");
    }
    const other = await linkState(links.other!);
    assert.equal(other.status, "pending");
    assert.equal(other.approver_device_id, devices[1]);
  });

  test("ignores unknown ids, duplicates and devices of other users", async () => {
    const mine = await fixture();
    const theirs = await fixture();
    const removed = await db.write((q) =>
      removeDevicesInTx(
        q,
        mine.userId,
        [mine.devices[2]!, theirs.devices[0]!, newId(), mine.devices[2]!, mine.devices[1]!],
        "token_reuse",
      ),
    );
    assert.deepEqual(removed.deviceIds, [mine.devices[2], mine.devices[1]]);
    assert.deepEqual(await deviceIds(theirs.userId), [...theirs.devices].sort());
    assert.equal((await linkState(theirs.links.pending!)).status, "pending", "another user's link is untouched");
    assert.equal((await linkState(mine.links.other!)).status, "cancelled");
  });

  test("an empty list does nothing", async () => {
    const { userId, devices } = await fixture();
    const removed = await db.write((q) => removeDevicesInTx(q, userId, [], "device_revoked"));
    assert.deepEqual(removed.deviceIds, []);
    assert.deepEqual(await deviceIds(userId), [...devices].sort());
  });

  test("removeAllDevicesInTx, with and without an exception", async () => {
    const { userId, devices } = await fixture();
    const others = await db.write((q) =>
      removeAllDevicesInTx(q, userId, "password_changed", { exceptDeviceId: devices[1]! }),
    );
    assert.deepEqual([...others.deviceIds].sort(), [devices[0]!, devices[2]!].sort());
    assert.deepEqual(await deviceIds(userId), [devices[1]]);
    const rest = await db.write((q) => removeAllDevicesInTx(q, userId, "account_deleted"));
    assert.deepEqual(rest.deviceIds, [devices[1]]);
    assert.deepEqual(await deviceIds(userId), []);
    assert.deepEqual(await tokenDevices(userId), []);
  });

  test("refuses to run outside db.write; a failed transaction removes nothing", async () => {
    const { userId, devices } = await fixture();
    await assert.rejects(
      db.read((q) => removeDevicesInTx(q, userId, devices, "device_revoked")),
      TxRuleError,
    );
    await assert.rejects(
      db.run((q) => removeAllDevicesInTx(q, userId, "device_revoked")),
      TxRuleError,
    );
    await assert.rejects(
      db.write(async (q) => {
        await removeDevicesInTx(q, userId, devices, "device_revoked");
        throw new Error("rollback");
      }),
      /rollback/,
    );
    assert.deepEqual(await deviceIds(userId), [...devices].sort());
  });
});
