/** `ctx.devices.touchLastSync` (DESIGN §3.8) on both dialects: at most one write per device and minute, never throws. */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Db } from "../db/index.ts";
import { createDevice, createUser } from "../test/factories.ts";
import { createMigratedTestDatabase } from "../test/test-db.ts";
import type { TestDatabase } from "../test/test-db.ts";
import { ManualClock, MINUTE_MS } from "./clock.ts";
import { createLastSyncToucher } from "./device-activity.ts";

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

async function lastSyncAt(deviceId: string): Promise<number | null> {
  const row = await db.read((q) =>
    q.selectFrom("devices").select("last_sync_at").where("id", "=", deviceId).executeTakeFirstOrThrow(),
  );
  return row.last_sync_at;
}

describe("touchLastSync", () => {
  test("writes now, then at most once a minute per device", async () => {
    const clock = new ManualClock(T0);
    const user = await createUser(db, { now: T0 });
    const a = await createDevice(db, user.id, { now: T0 });
    const b = await createDevice(db, user.id, { now: T0 });
    const toucher = createLastSyncToucher({ db, clock, log: { warn: () => undefined } });

    toucher.touchLastSync(a.id);
    await toucher.idle();
    assert.equal(await lastSyncAt(a.id), T0);

    clock.advance(30_000);
    toucher.touchLastSync(a.id);
    toucher.touchLastSync(b.id);
    await toucher.idle();
    assert.equal(await lastSyncAt(a.id), T0, "throttled");
    assert.equal(await lastSyncAt(b.id), T0 + 30_000, "another device is independent");

    clock.advance(MINUTE_MS);
    toucher.touchLastSync(a.id);
    await toucher.idle();
    assert.equal(await lastSyncAt(a.id), T0 + 90_000);
  });

  test("the WHERE clause keeps the rule for a second process (a fresh throttle)", async () => {
    const clock = new ManualClock(T0);
    const user = await createUser(db, { now: T0 });
    const device = await createDevice(db, user.id, { now: T0, lastSyncAt: T0 });
    clock.advance(10_000);
    const fresh = createLastSyncToucher({ db, clock, log: { warn: () => undefined } });
    fresh.touchLastSync(device.id);
    await fresh.idle();
    assert.equal(await lastSyncAt(device.id), T0);
  });

  test("a failing write is logged, never thrown", async () => {
    const warnings: string[] = [];
    const broken = { run: () => Promise.reject(new Error("database is gone")) } as unknown as Db;
    const toucher = createLastSyncToucher({
      db: broken,
      clock: new ManualClock(T0),
      log: { warn: (_details, message) => warnings.push(message) },
    });
    assert.doesNotThrow(() => {
      toucher.touchLastSync("9b1e2f4a-7c3d-4e5f-8a9b-0c1d2e3f4a5b");
    });
    await toucher.idle();
    assert.deepEqual(warnings, ["could not update devices.last_sync_at"]);
  });
});
