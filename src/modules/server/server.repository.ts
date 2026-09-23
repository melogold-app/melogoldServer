/**
 * `server_meta` and the server-wide epoch rotation (API §9.2 `0001_core`, DESIGN §3.15).
 *
 * `server_meta` keys: `server_id`, `created_at` (epoch ms as text), `first_user_id` (set by the first user creation,
 * DESIGN §4.2), `restore_pending` (`'1'` in every backup copy), `restore_refresh_grace_until` (epoch ms as text).
 */
import type { Queryable } from "../../db/index.ts";

export const META_SERVER_ID = "server_id";
export const META_CREATED_AT = "created_at";
export const META_FIRST_USER_ID = "first_user_id";
export const META_RESTORE_PENDING = "restore_pending";
export const META_RESTORE_REFRESH_GRACE_UNTIL = "restore_refresh_grace_until";

export async function readMeta(q: Queryable, key: string): Promise<string | null> {
  const row = await q.selectFrom("server_meta").select("value").where("key", "=", key).executeTakeFirst();
  return row?.value ?? null;
}

/** Inserts `key = value` unless the key exists (`ON CONFLICT DO NOTHING`); returns the stored value. */
export async function insertMetaIfAbsent(q: Queryable, key: string, value: string): Promise<string> {
  await q
    .insertInto("server_meta")
    .values({ key, value })
    .onConflict((conflict) => conflict.column("key").doNothing())
    .execute();
  const stored = await readMeta(q, key);
  if (stored === null) throw new Error(`server_meta.${key} is missing right after its insert`);
  return stored;
}

/** Sets `key = value` (insert or update). */
export async function upsertMeta(q: Queryable, key: string, value: string): Promise<void> {
  await q
    .insertInto("server_meta")
    .values({ key, value })
    .onConflict((conflict) => conflict.column("key").doUpdateSet({ value }))
    .execute();
}

export async function deleteMeta(q: Queryable, key: string): Promise<void> {
  await q.deleteFrom("server_meta").where("key", "=", key).execute();
}

/** One page of `sync_heads.user_id` after `afterUserId` (ordinal order of the `ID` collation). */
export async function headUserIdsAfter(q: Queryable, afterUserId: string | null, limit: number): Promise<string[]> {
  let query = q.selectFrom("sync_heads").select("user_id").orderBy("user_id").limit(limit);
  if (afterUserId !== null) query = query.where("user_id", ">", afterUserId);
  const rows = await query.execute();
  return rows.map((row) => row.user_id);
}

/** Gives one user a new cursor epoch (every cursor of the user becomes `410 cursor_invalid`). */
export async function setHeadEpoch(q: Queryable, userId: string, epoch: string, now: number): Promise<void> {
  await q.updateTable("sync_heads").set({ epoch, updated_at: now }).where("user_id", "=", userId).execute();
}

/** `SELECT 1` for `/health`. */
export async function ping(q: Queryable): Promise<void> {
  await q.selectNoFrom((eb) => eb.lit(1).as("one")).execute();
}
