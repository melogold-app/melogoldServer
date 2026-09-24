/**
 * The query of the heartbeat recheck (`findDeviceSessions`, DESIGN §4.7) on both dialects, and `revalidateStreams`
 * over a real database: devices that exist, are gone, belong to a deleted user or to another user; `auth_version`
 * compared with the stream's `av`; more than 1000 devices are read in chunks (`IN_BATCH_VALUES`).
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { IN_BATCH_VALUES } from "../../db/batch.ts";
import type { Db } from "../../db/index.ts";
import { ManualClock } from "../../lib/clock.ts";
import { newId } from "../../lib/ids.ts";
import { createDevice, createUser } from "../../test/factories.ts";
import { createMigratedTestDatabase } from "../../test/test-db.ts";
import type { TestDatabase } from "../../test/test-db.ts";
import { LiveHub } from "./live.hub.ts";
import type { LiveCloseReason } from "./live.hub.ts";
import type { LiveEvent } from "./live.events.ts";
import { findDeviceSessions, revalidateStreams } from "./revalidate.ts";

const T0 = Date.UTC(2026, 8, 23, 10, 0, 0);

let database: TestDatabase;
let db: Db;

before(async () => {
  ({ database, db } = await createMigratedTestDatabase());
});

after(async () => {
  await db.destroy();
  await database.cleanup();
});

function newHub() {
  const clock = new ManualClock(T0);
  return new LiveHub({
    clock,
    log: { warn: () => undefined, error: () => undefined },
    maxStreamsPerDevice: 4,
    maxStreamsPerUser: 64,
    timers: { setTimeout: () => null, clearTimeout: () => undefined },
  });
}

type Seen = { events: LiveEvent[]; closed: LiveCloseReason[] };

function openStream(hub: LiveHub, userId: string, deviceId: string, authVersion: number) {
  const seen: Seen = { events: [], closed: [] };
  const { stream } = hub.register({
    userId,
    deviceId,
    authVersion,
    expiresAt: T0 + 900_000,
    send: (event) => seen.events.push(event),
    close: (reason) => seen.closed.push(reason),
  });
  return { stream, seen };
}

describe("findDeviceSessions", () => {
  test("each existing device with its user's auth_version and deleted_at; unknown ids are absent", async () => {
    const alive = await createUser(db, { now: T0, authVersion: 3 });
    const deleted = await createUser(db, { now: T0, deletedAt: T0 + 1000 });
    const phone = await createDevice(db, alive.id, { now: T0 });
    const laptop = await createDevice(db, alive.id, { now: T0 });
    const orphan = await createDevice(db, deleted.id, { now: T0 });
    const unknown = newId();

    const rows = await db.run((q) => findDeviceSessions(q, [phone.id, laptop.id, orphan.id, unknown]));
    const byId = new Map(rows.map((row) => [row.deviceId, row]));
    assert.equal(rows.length, 3);
    assert.deepEqual(byId.get(phone.id), {
      deviceId: phone.id,
      userId: alive.id,
      authVersion: 3,
      userDeletedAt: null,
    });
    assert.deepEqual(byId.get(laptop.id), {
      deviceId: laptop.id,
      userId: alive.id,
      authVersion: 3,
      userDeletedAt: null,
    });
    assert.deepEqual(byId.get(orphan.id), {
      deviceId: orphan.id,
      userId: deleted.id,
      authVersion: 1,
      userDeletedAt: T0 + 1000,
    });
    assert.equal(byId.has(unknown), false);
  });
});

describe("revalidateStreams", () => {
  test("gone and deleted-user devices are invalidated, other av closes, live devices stay", async () => {
    const user = await createUser(db, { now: T0, authVersion: 2 });
    const deletedUser = await createUser(db, { now: T0 });
    const kept = await createDevice(db, user.id, { now: T0 });
    const removed = await createDevice(db, user.id, { now: T0 });
    const ofDeleted = await createDevice(db, deletedUser.id, { now: T0 });
    const hub = newHub();
    const current = openStream(hub, user.id, kept.id, 2);
    const stale = openStream(hub, user.id, kept.id, 1);
    const gone = openStream(hub, user.id, removed.id, 2);
    const orphan = openStream(hub, deletedUser.id, ofDeleted.id, 1);

    await db.write((q) => q.deleteFrom("devices").where("id", "=", removed.id).execute());
    await db.write((q) =>
      q
        .updateTable("users")
        .set({ deleted_at: T0 + 5000 })
        .where("id", "=", deletedUser.id)
        .execute(),
    );

    const plan = await revalidateStreams({ db, hub }, hub.streams());
    assert.deepEqual(plan.invalidated, [
      { userId: user.id, deviceId: removed.id, reason: "device_revoked" },
      { userId: deletedUser.id, deviceId: ofDeleted.id, reason: "account_deleted" },
    ]);
    assert.deepEqual(plan.outdated, [stale.stream]);

    assert.deepEqual(current.seen, { events: [], closed: [] });
    assert.deepEqual(stale.seen, { events: [], closed: ["outdated"] });
    assert.deepEqual(
      gone.seen.events.map((event) => [event.type, event.payload]),
      [["session.invalidated", { reason: "device_revoked", forceRelogin: true }]],
    );
    assert.deepEqual(gone.seen.closed, ["device_closed"]);
    assert.deepEqual(
      orphan.seen.events.map((event) => [event.type, event.payload]),
      [["session.invalidated", { reason: "account_deleted", forceRelogin: true }]],
    );
    assert.deepEqual(orphan.seen.closed, ["device_closed"]);
    assert.deepEqual(hub.streams(), [current.stream]);
  });

  test("more than 1000 devices: one query per chunk of IN_BATCH_VALUES, every stream checked", async () => {
    const user = await createUser(db, { now: T0 });
    const real = await createDevice(db, user.id, { now: T0 });
    const hub = newHub();
    const strangers = Array.from({ length: IN_BATCH_VALUES + 5 }, () => openStream(hub, newId(), newId(), 1));
    const mine = openStream(hub, user.id, real.id, 1);

    let statements = 0;
    const counting: Pick<Db, "run"> = {
      run: (fn) => {
        statements += 1;
        return db.run(fn);
      },
    };
    const plan = await revalidateStreams({ db: counting, hub }, hub.streams());
    assert.equal(statements, 2);
    assert.equal(plan.invalidated.length, IN_BATCH_VALUES + 5);
    assert.ok(plan.invalidated.every((entry) => entry.reason === "device_revoked"));
    assert.ok(strangers.every((stranger) => stranger.seen.closed.length === 1));
    assert.deepEqual(mine.seen, { events: [], closed: [] });
    assert.deepEqual(hub.streams(), [mine.stream]);
  });
});
