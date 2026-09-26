/**
 * Queries of the `maintenance` module (PLAN T3.1): the hourly auth cleanup (DESIGN §4.12) and the SQLite upkeep
 * (API §9.4). Every delete removes at most `limit` rows portably (`… WHERE pk IN (SELECT pk … LIMIT ?)`, PostgreSQL
 * has no `DELETE … LIMIT`), so the jobs run it through `deleteInBatches`, one short `db.write` per batch.
 */
import { sql } from "kysely";
import type { Queryable } from "../../db/index.ts";

/**
 * Refresh tokens nobody can use any more (DESIGN §4.12): expired more than `before` ago, or rotated or revoked with
 * their grace window over before `before`.
 */
export async function deleteStaleRefreshTokens(q: Queryable, before: number, limit: number): Promise<number> {
  const result = await q
    .deleteFrom("refresh_tokens")
    .where((eb) =>
      eb(
        "id",
        "in",
        eb
          .selectFrom("refresh_tokens")
          .select("id")
          .where((inner) =>
            inner.or([
              inner("expires_at", "<", before),
              inner.and([inner("rotated_to_id", "is not", null), inner("rotation_grace_expires_at", "<", before)]),
              inner("revoked_at", "<", before),
            ]),
          )
          .limit(limit),
      ),
    )
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}

/** Device links expired before `before` (DESIGN §4.12: `expires_at < now − 1 h`), whatever their status. */
export async function deleteExpiredLinks(q: Queryable, before: number, limit: number): Promise<number> {
  const result = await q
    .deleteFrom("device_links")
    .where((eb) =>
      eb("id", "in", eb.selectFrom("device_links").select("id").where("expires_at", "<", before).limit(limit)),
    )
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}

/**
 * Throttle rows untouched since `before` without an active lock at `now` (DESIGN §4.12: older than a day). A lock
 * still running keeps its row, whatever its age.
 */
export async function deleteStaleThrottle(q: Queryable, before: number, now: number, limit: number): Promise<number> {
  const result = await q
    .deleteFrom("auth_throttle")
    .where((eb) =>
      eb(
        eb.refTuple("scope", "key_hash"),
        "in",
        eb
          .selectFrom("auth_throttle")
          .select(["scope", "key_hash"])
          .where("updated_at", "<", before)
          .where((inner) => inner.or([inner("locked_until", "is", null), inner("locked_until", "<=", now)]))
          .limit(limit)
          .$asTuple("scope", "key_hash"),
      ),
    )
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}

/** SQLite: refreshes the planner statistics (`PRAGMA optimize`, API §9.4: on open and every 6 h). */
export async function optimizeSqlite(q: Queryable): Promise<void> {
  await sql`PRAGMA optimize`.execute(q);
}

/** SQLite: pages on the free list (freed by deletes, not yet given back to the file system). */
export async function freePagesSqlite(q: Queryable): Promise<number> {
  const result = await sql<{ freelist_count: number }>`PRAGMA freelist_count`.execute(q);
  return result.rows[0]?.freelist_count ?? 0;
}

/**
 * SQLite: gives up to `maxPages` free pages back to the file system (the database is `auto_vacuum = INCREMENTAL`,
 * API §9.1), inside the caller's `db.write`. The pragma frees one page per step and better-sqlite3 steps a statement
 * without result columns only once, so it is run once per page; in one transaction that costs no extra fsync.
 * @returns how many pages were given back.
 */
export async function incrementalVacuumSqlite(q: Queryable, maxPages: number): Promise<number> {
  const before = await freePagesSqlite(q);
  const steps = Math.min(before, maxPages);
  for (let step = 0; step < steps; step++) await sql`PRAGMA incremental_vacuum`.execute(q);
  return before - (await freePagesSqlite(q));
}

/** SQLite: folds the WAL into the database and truncates it. Returns whether readers kept part of it (`busy`). */
export async function checkpointSqlite(q: Queryable): Promise<boolean> {
  const result = await sql<{ busy: number }>`PRAGMA wal_checkpoint(TRUNCATE)`.execute(q);
  return (result.rows[0]?.busy ?? 0) !== 0;
}

/** Accounts on the server: active, and deleted but not purged yet (`deleted_at` set). */
export async function countUsers(q: Queryable): Promise<Readonly<{ active: number; deleted: number }>> {
  const count = async (deleted: boolean) => {
    const row = await q
      .selectFrom("users")
      .select((eb) => eb.fn.countAll<number | string>().as("count"))
      .where("deleted_at", deleted ? "is not" : "is", null)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  };
  return Object.freeze({ active: await count(false), deleted: await count(true) });
}

/** Devices of every account. */
export async function countDevices(q: Queryable): Promise<number> {
  const row = await q
    .selectFrom("devices")
    .select((eb) => eb.fn.countAll<number | string>().as("count"))
    .executeTakeFirstOrThrow();
  return Number(row.count);
}
