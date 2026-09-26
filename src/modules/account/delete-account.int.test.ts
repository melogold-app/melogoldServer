/**
 * `POST /auth/me/delete` and the `account-purge` job (API §4.5, DESIGN §4.11), both dialects (PLAN T1.3
 * `delete-account.int`):
 * - wrong password → `403 invalid_password`, nothing changes;
 * - right password → `204`; the login is freed at once; every device is removed;
 *   `session.invalidated{account_deleted}` to each device, then the user's streams close; the guard itself answers
 *   `session_revoked` afterwards (the device row is gone, not merely `auth_version` bumped);
 * - after `account-purge` runs, no row of the user remains in any table it owns;
 * - `account-purge` proceeds in bounded batches (one short `db.write` each), never one unbounded delete.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { argon2id, hash } from "argon2";
import { sql } from "kysely";
import type { LiveEvent } from "../../contract/live.ts";
import type { LiveCloseReason } from "../live/live.hub.ts";
import { lockUser } from "../../db/heads.ts";
import { newId } from "../../lib/ids.ts";
import { removeAllDevicesInTx } from "../../lib/device-removal.ts";
import { bearer, createAccount, createDevice } from "../../test/factories.ts";
import { assertError, createTestApp } from "../../test/test-app.ts";
import type { TestApp } from "../../test/test-app.ts";
import { deleteLinksAndPlayback } from "./account.repository.ts";
import { PURGE_TABLES, purgeDeletedAccounts } from "./purge.job.ts";

const PASSWORD = "правильный пароль";

/** A cheap argon2id hash of a test password (verification reads the cost from the PHC string). */
function testHash(password: string): Promise<string> {
  return hash(password.normalize("NFKC"), { type: argon2id, memoryCost: 1024, timeCost: 1, parallelism: 1 });
}

type Listener = { events: LiveEvent[]; closed: LiveCloseReason[] };

function listen(t: TestApp, userId: string, deviceId: string): Listener {
  const listener: Listener = { events: [], closed: [] };
  t.ctx.live.register({
    userId,
    deviceId,
    authVersion: 1,
    expiresAt: t.clock.now() + 3_600_000,
    send: (event) => listener.events.push(event),
    close: (reason) => listener.closed.push(reason),
  });
  return listener;
}

function deleteAccount(t: TestApp, token: string, body: unknown) {
  return t.app.inject({
    method: "POST",
    url: "/auth/me/delete",
    headers: { ...bearer(token), "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
}

async function userRow(t: TestApp, userId: string) {
  return t.db.run((q) => q.selectFrom("users").selectAll().where("id", "=", userId).executeTakeFirst());
}

/**
 * Marks a user deleted exactly as `account.service.ts#deleteAccount` does (DESIGN §4.11 steps 1-5), without going
 * through the HTTP route: this is what `account-purge` finds waiting for it in production.
 */
async function markDeleted(t: TestApp, userId: string): Promise<void> {
  await t.db.write(async (q) => {
    await lockUser(q, userId);
    await q
      .updateTable("users")
      .set({ password_hash: "!", deleted_at: t.clock.now(), login: `!deleted:${userId}` })
      .where("id", "=", userId)
      .execute();
    await removeAllDevicesInTx(q, userId, "account_deleted");
    await deleteLinksAndPlayback(q, userId);
  });
}

async function countRows(t: TestApp, table: string, userId: string): Promise<number> {
  const result = await t.db.run((q) =>
    sql<{ n: number | string }>`SELECT COUNT(*) AS n FROM ${sql.table(table)} WHERE user_id = ${userId}`.execute(q),
  );
  return Number(result.rows[0]?.n ?? 0);
}

const noopLog = { info: () => undefined, error: () => undefined };

describe("POST /auth/me/delete", () => {
  let t: TestApp;

  before(async () => {
    t = await createTestApp();
  });

  after(async () => {
    await t.close();
  });

  test("wrong password → 403 invalid_password; nothing changes", async () => {
    const account = await createAccount(t.ctx, { user: { passwordHash: await testHash(PASSWORD) } });
    const response = await deleteAccount(t, account.session.tokens.accessToken, { password: "не тот пароль" });
    assertError(response, 403, "invalid_password");
    const row = await userRow(t, account.user.id);
    assert.equal(row?.deleted_at, null);
    assert.equal(row.login, account.user.login);
  });

  test("right password → 204; login freed at once; devices removed; account_deleted then user streams close", async () => {
    const account = await createAccount(t.ctx, { user: { passwordHash: await testHash(PASSWORD) } });
    const other = await createDevice(t.db, account.user.id, {
      name: "Windows",
      linkedVia: "link",
      now: t.clock.now(),
    });
    const onOwner = listen(t, account.user.id, account.device.id);
    const onOther = listen(t, account.user.id, other.id);

    const response = await deleteAccount(t, account.session.tokens.accessToken, { password: PASSWORD });
    assert.equal(response.statusCode, 204, response.body);
    assert.equal(response.body, "");

    const row = await userRow(t, account.user.id);
    assert.ok(row);
    assert.ok(row.deleted_at !== null);
    assert.equal(row.login, `!deleted:${account.user.id}`, "the real login is freed immediately");
    assert.equal(row.password_hash, "!");
    assert.equal(row.auth_version, 2);

    const devices = await t.db.run((q) =>
      q.selectFrom("devices").select("id").where("user_id", "=", account.user.id).execute(),
    );
    assert.deepEqual(devices, [], "every device is gone");

    // Both removed devices are addressed individually (session.invalidated{account_deleted} → closeDevice each);
    // by the time closeUser runs there is nothing left open for it to close, so no separate "user_closed" fires.
    for (const listener of [onOwner, onOther]) {
      assert.deepEqual(
        listener.events.map((event) => [event.type, event.payload]),
        [["session.invalidated", { reason: "account_deleted", forceRelogin: true }]],
      );
      assert.deepEqual(listener.closed, ["device_closed"]);
    }

    // The device row is gone, not merely `auth_version` bumped: the guard itself answers session_revoked.
    const again = await t.app.inject({
      method: "GET",
      url: "/auth/me/export",
      headers: bearer(account.session.tokens.accessToken),
    });
    assertError(again, 401, "session_revoked");

    // A second delete call answers the same way: no account left to delete.
    assertError(
      await deleteAccount(t, account.session.tokens.accessToken, { password: PASSWORD }),
      401,
      "session_revoked",
    );
  });

  test("a login freed by deletion can belong to a new account (the unique index does not block it)", async () => {
    const account = await createAccount(t.ctx, { user: { passwordHash: await testHash(PASSWORD) } });
    const login = account.user.login;
    const response = await deleteAccount(t, account.session.tokens.accessToken, { password: PASSWORD });
    assert.equal(response.statusCode, 204, response.body);
    // Insert a brand-new user under the freed login directly (the real path is POST /auth/register, still a stub in
    // this worktree): if the login were not actually freed, this unique constraint would reject it.
    const now = t.clock.now();
    await t.db.write((q) =>
      q
        .insertInto("users")
        .values({
          id: newId(),
          login,
          password_hash: "$argon2id$stub",
          password_changed_at: now,
          recovery_code_hash: "0".repeat(64),
          recovery_code_created_at: now,
          created_at: now,
          updated_at: now,
        })
        .execute(),
    );
  });
});

describe("account-purge (DESIGN §4.11)", () => {
  let t: TestApp;

  before(async () => {
    t = await createTestApp();
  });

  after(async () => {
    await t.close();
  });

  /** Tables the deletion step itself already empties (DESIGN §4.11 steps 4-5): purge only has to find them gone. */
  const ALREADY_EMPTIED_BY_DELETE = new Set(["devices", "refresh_tokens", "device_links", "playback_state"]);

  /** One row in every table PURGE_TABLES empties that deletion does not already empty, plus `sync_heads`. */
  async function seedPurgeableRows(userId: string): Promise<void> {
    const now = t.clock.now();
    await t.db.write(async (q) => {
      await q
        .insertInto("sync_ops")
        .values({
          user_id: userId,
          seq: 1,
          op_id: newId(),
          device_id: null,
          device_name: null,
          kind: "like.set",
          payload: "{}",
          status: "applied",
          code: null,
          result: null,
          client_at: now,
          eff_at: now,
          base_seq: null,
          pre_image: null,
          server_at: now,
        })
        .execute();
      await q
        .insertInto("sync_tracks")
        .values({
          user_id: userId,
          video_id: "vidPURGEonx",
          title: "t",
          artists_text: null,
          artists: null,
          album_id: null,
          album_title: null,
          duration_ms: null,
          duration_text: null,
          thumbnail_url: null,
          video_type: null,
          seq: 1,
          updated_at: now,
        })
        .execute();
      await q
        .insertInto("sync_likes")
        .values({
          user_id: userId,
          video_id: "vidPURGEonx",
          liked: 1,
          liked_at: now,
          seq: 1,
          clk_at: now,
          clk_dev: null,
        })
        .execute();
      await q
        .insertInto("sync_bookmarks")
        .values({
          user_id: userId,
          type: "album",
          browse_id: "MPREb_purge",
          bookmarked: 1,
          bookmarked_at: now,
          title: null,
          subtitle: null,
          thumbnail_url: null,
          year: null,
          seq: 1,
          clk_at: now,
          clk_dev: null,
        })
        .execute();
      await q
        .insertInto("sync_track_overrides")
        .values({
          user_id: userId,
          video_id: "vidPURGEonx",
          title: "t",
          artists_text: null,
          album_title: null,
          updated_at: now,
          seq: 1,
          deleted: 0,
          clk_at: now,
          clk_dev: null,
        })
        .execute();
      await q
        .insertInto("sync_lyrics_pins")
        .values({
          user_id: userId,
          video_id: "vidPURGEonx",
          source: "lrclib",
          ref: "1",
          start_time_ms: null,
          updated_at: now,
          seq: 1,
          deleted: 0,
          clk_at: now,
          clk_dev: null,
        })
        .execute();
      const playlistId = newId();
      await q
        .insertInto("sync_playlists")
        .values({
          user_id: userId,
          id: playlistId,
          name: "p",
          browse_id: null,
          thumbnail_url: null,
          created_at: now,
          deleted: 0,
          deleted_at: null,
          deleted_seq: null,
          seq: 1,
          clk_at: now,
          clk_dev: null,
        })
        .execute();
      await q
        .insertInto("sync_playlist_items")
        .values({
          user_id: userId,
          playlist_id: playlistId,
          video_id: "vidPURGEonx",
          present: 1,
          sort_key: "m",
          added_at: now,
          seq: 1,
          mem_seq: 1,
          mem_at: now,
          mem_dev: null,
          pos_seq: 1,
          pos_at: now,
          pos_dev: null,
        })
        .execute();
      await q
        .insertInto("play_events")
        .values({
          user_id: userId,
          event_id: newId(),
          video_id: "vidPURGEonx",
          played_at: now,
          play_time_ms: 1000,
          in_history: 1,
          counts_playtime: 1,
          device_id: null,
          seq: 1,
          received_at: now,
        })
        .execute();
      await q
        .insertInto("play_stats")
        .values({ user_id: userId, video_id: "vidPURGEonx", total_ms: 1000, last_played_at: now, seq: 1 })
        .execute();
      await q
        .insertInto("play_forgets")
        .values({ user_id: userId, video_id: "*", events_before: now, total_before: now, seq: 1 })
        .execute();
      // device_links, refresh_tokens, devices and playback_state are already emptied by the deletion itself
      // (DESIGN §4.11 steps 4-5): account-purge only has to find them already gone.
    });
  }

  test("purges every table of a deleted account; the users row goes last", async () => {
    const account = await createAccount(t.ctx);
    await seedPurgeableRows(account.user.id);
    await markDeleted(t, account.user.id);

    for (const { table } of PURGE_TABLES) {
      const before = await countRows(t, table, account.user.id);
      if (ALREADY_EMPTIED_BY_DELETE.has(table)) {
        assert.equal(before, 0, `${table} already emptied by the deletion itself`);
      } else {
        assert.ok(before > 0, `${table} seeded`);
      }
    }

    const report = await purgeDeletedAccounts({ db: t.db, log: noopLog });
    assert.equal(report.purgedAccounts, 1);
    assert.equal(report.failedAccounts, 0);
    const seededTables = PURGE_TABLES.filter((item) => !ALREADY_EMPTIED_BY_DELETE.has(item.table));
    assert.ok(report.deletedRows >= seededTables.length, "at least the one seeded row per seeded table");

    for (const { table } of PURGE_TABLES) {
      assert.equal(await countRows(t, table, account.user.id), 0, `${table} empty after purge`);
    }
    assert.equal(await countRows(t, "sync_heads", account.user.id), 0, "sync_heads empty after purge");
    assert.equal(await userRow(t, account.user.id), undefined, "the users row itself is gone");
  });

  test("proceeds in bounded batches: a table with more rows than the batch size needs several batches", async () => {
    const account = await createAccount(t.ctx);
    const now = t.clock.now();
    const ROWS = 5;
    await t.db.write((q) =>
      q
        .insertInto("sync_tracks")
        .values(
          Array.from({ length: ROWS }, (_, i) => ({
            user_id: account.user.id,
            video_id: `vidBATCH00${i}`,
            title: "t",
            artists_text: null,
            artists: null,
            album_id: null,
            album_title: null,
            duration_ms: null,
            duration_text: null,
            thumbnail_url: null,
            video_type: null,
            seq: i + 1,
            updated_at: now,
          })),
        )
        .execute(),
    );
    await markDeleted(t, account.user.id);

    const report = await purgeDeletedAccounts({ db: t.db, log: noopLog }, { batchSize: 2 });
    assert.equal(report.purgedAccounts, 1);
    assert.equal(await countRows(t, "sync_tracks", account.user.id), 0);
    assert.equal(await userRow(t, account.user.id), undefined);
  });

  test("an account not (yet) deleted is left alone", async () => {
    const account = await createAccount(t.ctx);
    const report = await purgeDeletedAccounts({ db: t.db, log: noopLog });
    assert.equal(report.purgedAccounts, 0);
    assert.ok(await userRow(t, account.user.id));
  });
});
