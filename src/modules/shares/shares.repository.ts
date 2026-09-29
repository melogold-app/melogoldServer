/** `shares` (API §9.2 `0008_shares_remote`, §4.11): snapshots of own playlists by link. */
import { z } from "zod";
import { TrackDto } from "../../contract/common.ts";
import { jsonCodec } from "../../db/codecs.ts";
import type { Queryable } from "../../db/index.ts";

const tracksCodec = jsonCodec(z.array(TrackDto), "shares.tracks");

export type StoredShare = Readonly<{
  id: string;
  userId: string;
  kind: string;
  name: string;
  tracks: readonly TrackDto[];
  createdAt: number;
}>;

function fromRow(row: {
  id: string;
  user_id: string;
  kind: string;
  name: string;
  tracks: string;
  created_at: number;
}): StoredShare {
  return Object.freeze({
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    name: row.name,
    tracks: tracksCodec.decode(row.tracks),
    createdAt: row.created_at,
  });
}

/** How many snapshots the user has (the `maxShares` limit). */
export async function countShares(q: Queryable, userId: string): Promise<number> {
  const row = await q
    .selectFrom("shares")
    .select((eb) => eb.fn.countAll<number | string>().as("count"))
    .where("user_id", "=", userId)
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

/**
 * Stores a snapshot under `id` (`INSERT … ON CONFLICT (id) DO NOTHING RETURNING`, docs/database.md §3).
 * @returns whether this id was free (`false`: pick another id).
 */
export async function insertShare(q: Queryable, share: StoredShare): Promise<boolean> {
  const inserted = await q
    .insertInto("shares")
    .values({
      id: share.id,
      user_id: share.userId,
      kind: share.kind,
      name: share.name,
      tracks: tracksCodec.encode([...share.tracks]),
      created_at: share.createdAt,
    })
    .onConflict((conflict) => conflict.column("id").doNothing())
    .returning("id")
    .executeTakeFirst();
  return inserted !== undefined;
}

/** A snapshot by id, whoever owns it (the public link). */
export async function findShare(q: Queryable, id: string): Promise<StoredShare | null> {
  const row = await q.selectFrom("shares").selectAll().where("id", "=", id).executeTakeFirst();
  return row ? fromRow(row) : null;
}

/** The user's snapshots, newest first. */
export async function listShares(q: Queryable, userId: string): Promise<StoredShare[]> {
  const rows = await q
    .selectFrom("shares")
    .selectAll()
    .where("user_id", "=", userId)
    .orderBy("created_at", "desc")
    .orderBy("id")
    .execute();
  return rows.map(fromRow);
}

/** Deletes the user's snapshot. @returns whether it existed and was theirs. */
export async function deleteShare(q: Queryable, userId: string, id: string): Promise<boolean> {
  const result = await q.deleteFrom("shares").where("id", "=", id).where("user_id", "=", userId).executeTakeFirst();
  return result.numDeletedRows === 1n;
}
