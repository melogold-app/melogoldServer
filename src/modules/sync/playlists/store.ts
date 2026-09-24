/**
 * Rows of `sync_playlists` and `sync_playlist_items` for the `playlist.*` op handlers (DESIGN §3.4, §3.7, §3.10;
 * API §9.2). Every function runs inside the `/sync` write transaction that holds `lockUser` (the `q` of the
 * `OpCtx`), so a read followed by a write of the same rows is safe in both dialects (docs/database.md §2.5).
 *
 * **Registers.** A playlist header is one register (`seq`, `clk_at`, `clk_dev`); an item has two, membership
 * (`mem_*`) and position (`pos_*`). A write gets one `seq` per row from `oc.next()`; the item's `seq` is
 * `max(mem_seq, pos_seq)` (API §9.2), so a row whose key changes gets a new `pos_seq` as well.
 *
 * **Edits of items.** A handler describes what it changes ({@link PlannedItem}: new membership, which registers it
 * writes) and where the newly placed items go ({@link Placement}: a run of videoIds right after `lower`, before
 * `upper`). {@link commitItems} issues the keys between the neighbours; when a bound is unusable or a new key would be
 * longer than 48 characters, it rebalances: every present item of the playlist gets a fresh key in the final order,
 * and a new `seq` (DESIGN §3.7).
 *
 * **Quotas** (DESIGN §3.10): live playlists (1000) and all item rows of the user, tombstones included (100 000), are
 * counted with one `COUNT(*)` per request through `oc.counters`; the present items of one playlist (10 000) are its
 * `item_count` column, kept exact by every write here (it never moves the playlist's `seq`).
 */
import type { Insertable, Selectable } from "kysely";
import { SYNC_LIMITS } from "../../../contract/limits.ts";
import { insertInChunks, selectInChunks } from "../../../db/batch.ts";
import { fromDbBool, toDbBool } from "../../../db/codecs.ts";
import type { SyncPlaylistItemsTable, SyncPlaylistsTable } from "../../../db/types.ts";
import { itemKey } from "../ops/types.ts";
import type { OpCtx, OpEnv } from "../ops/types.ts";
import { keysBetween, tryKeysBetween } from "./sort-keys.ts";

/** `oc.counters` keys of this module (DESIGN §3.10). */
export const LIVE_PLAYLISTS_COUNTER = "sync_playlists.live";
export const ITEM_ROWS_COUNTER = "sync_playlist_items.rows";

// ---------------------------------------------------------------------------------------------------------------------
// Registers (DESIGN §3.4)
// ---------------------------------------------------------------------------------------------------------------------

export type Register = Readonly<{ seq: number; at: number; dev: string | null }>;

/** The side of an op in a register comparison: `base` (libSeq of its cursor or `null`), `effAt`, author device. */
export type RegisterWriter = Readonly<{ base: number | null; effAt: number; dev: string }>;

/**
 * DESIGN §3.4 `wins`, verbatim: the op wins when the register is empty, when its author saw the current value
 * (`reg.seq <= base`), when it is later, or on a tie of the same device or of the greater device id.
 *
 * The same rule as `../wins.ts` of the sync core (PLAN T2.1); kept here while both tasks are built in parallel.
 */
export function wins(reg: Register | null, op: RegisterWriter): boolean {
  return (
    reg === null ||
    (op.base !== null && reg.seq <= op.base) ||
    op.effAt > reg.at ||
    (op.effAt === reg.at && (op.dev === reg.dev || op.dev > (reg.dev ?? "")))
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Playlists
// ---------------------------------------------------------------------------------------------------------------------

export type PlaylistRecord = Readonly<{
  id: string;
  name: string;
  browseId: string | null;
  thumbnailUrl: string | null;
  createdAt: number;
  deleted: boolean;
  deletedSeq: number | null;
  itemCount: number;
  /** The header register. */
  header: Register;
}>;

function toPlaylist(row: Selectable<SyncPlaylistsTable>): PlaylistRecord {
  return Object.freeze({
    id: row.id,
    name: row.name,
    browseId: row.browse_id,
    thumbnailUrl: row.thumbnail_url,
    createdAt: row.created_at,
    deleted: fromDbBool(row.deleted),
    deletedSeq: row.deleted_seq,
    itemCount: row.item_count,
    header: Object.freeze({ seq: row.seq, at: row.clk_at, dev: row.clk_dev }),
  });
}

export async function findPlaylist(oc: OpCtx, playlistId: string): Promise<PlaylistRecord | null> {
  const row = await oc.q
    .selectFrom("sync_playlists")
    .selectAll()
    .where("user_id", "=", oc.userId)
    .where("id", "=", playlistId)
    .executeTakeFirst();
  return row ? toPlaylist(row) : null;
}

export type NewPlaylist = Readonly<{
  id: string;
  name: string;
  browseId: string | null;
  thumbnailUrl: string | null;
  itemCount: number;
}>;

/**
 * Inserts a live playlist created by the op (header register = the op, `created_at` = `effAt`) and counts it in the
 * live-playlist quota. The caller checked that no row exists (under `lockUser`) and that the quota allows it.
 */
export async function insertPlaylist(oc: OpCtx, playlist: NewPlaylist, effAt: number): Promise<PlaylistRecord> {
  const seq = oc.next();
  await oc.q
    .insertInto("sync_playlists")
    .values({
      user_id: oc.userId,
      id: playlist.id,
      name: playlist.name,
      browse_id: playlist.browseId,
      thumbnail_url: playlist.thumbnailUrl,
      created_at: effAt,
      deleted: 0,
      deleted_at: null,
      deleted_seq: null,
      item_count: playlist.itemCount,
      seq,
      clk_at: effAt,
      clk_dev: oc.deviceId,
    })
    .execute();
  oc.counters.add(LIVE_PLAYLISTS_COUNTER, 1);
  oc.touched.playlists.add(playlist.id);
  return Object.freeze({
    id: playlist.id,
    name: playlist.name,
    browseId: playlist.browseId,
    thumbnailUrl: playlist.thumbnailUrl,
    createdAt: effAt,
    deleted: false,
    deletedSeq: null,
    itemCount: playlist.itemCount,
    header: Object.freeze({ seq, at: effAt, dev: oc.deviceId }),
  });
}

/** Writes the header register of a live playlist (`playlist.update`). */
export async function updatePlaylistHeader(
  oc: OpCtx,
  playlistId: string,
  header: Readonly<{ name: string; thumbnailUrl: string | null }>,
  effAt: number,
): Promise<void> {
  const seq = oc.next();
  await oc.q
    .updateTable("sync_playlists")
    .set({ name: header.name, thumbnail_url: header.thumbnailUrl, seq, clk_at: effAt, clk_dev: oc.deviceId })
    .where("user_id", "=", oc.userId)
    .where("id", "=", playlistId)
    .execute();
  oc.touched.playlists.add(playlistId);
}

/**
 * Deletes a live playlist for good (`playlist.delete`): `deleted = 1`, `deleted_seq` = the row's new `seq`, and its
 * items (tombstones included) are removed physically.
 */
export async function deletePlaylist(oc: OpCtx, playlistId: string, effAt: number): Promise<void> {
  const removed = await oc.q
    .deleteFrom("sync_playlist_items")
    .where("user_id", "=", oc.userId)
    .where("playlist_id", "=", playlistId)
    .executeTakeFirst();
  const seq = oc.next();
  await oc.q
    .updateTable("sync_playlists")
    .set({ deleted: 1, deleted_at: effAt, deleted_seq: seq, item_count: 0, seq })
    .where("user_id", "=", oc.userId)
    .where("id", "=", playlistId)
    .execute();
  oc.counters.add(LIVE_PLAYLISTS_COUNTER, -1);
  oc.counters.add(ITEM_ROWS_COUNTER, -Number(removed.numDeletedRows));
  oc.touched.playlists.add(playlistId);
}

/** `item_count` after a change of present items; the playlist keeps its `seq` (API §9.2). */
export async function setItemCount(oc: OpCtx, playlistId: string, itemCount: number): Promise<void> {
  await oc.q
    .updateTable("sync_playlists")
    .set({ item_count: itemCount })
    .where("user_id", "=", oc.userId)
    .where("id", "=", playlistId)
    .execute();
}

// ---------------------------------------------------------------------------------------------------------------------
// Quotas (DESIGN §3.10)
// ---------------------------------------------------------------------------------------------------------------------

/** Whether one more live playlist fits the quota of 1000. */
export async function livePlaylistQuotaAllows(oc: OpCtx): Promise<boolean> {
  const live = await oc.counters.get(LIVE_PLAYLISTS_COUNTER, async () => {
    const row = await oc.q
      .selectFrom("sync_playlists")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("user_id", "=", oc.userId)
      .where("deleted", "=", 0)
      .executeTakeFirstOrThrow();
    return row.count;
  });
  return live + 1 <= SYNC_LIMITS.maxPlaylists;
}

/**
 * Whether an edit fits the item quotas: present items of the playlist after the edit (only checked when it grows)
 * and all item rows of the user, tombstones included, after `newRows` inserts.
 */
export async function itemQuotaAllows(
  oc: OpCtx,
  itemCountBefore: number,
  presentDelta: number,
  newRows: number,
): Promise<boolean> {
  if (presentDelta > 0 && itemCountBefore + presentDelta > SYNC_LIMITS.maxPlaylistItems) return false;
  if (newRows <= 0) return true;
  const rows = await oc.counters.get(ITEM_ROWS_COUNTER, async () => {
    const row = await oc.q
      .selectFrom("sync_playlist_items")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("user_id", "=", oc.userId)
      .executeTakeFirstOrThrow();
    return row.count;
  });
  return rows + newRows <= SYNC_LIMITS.maxItemsTotal;
}

// ---------------------------------------------------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------------------------------------------------

export type ItemRecord = Readonly<{
  videoId: string;
  present: boolean;
  sortKey: string;
  addedAt: number;
  seq: number;
  mem: Register;
  pos: Register;
}>;

/** A present item as a bound of a placement: order is `(sortKey, videoId)`, ordinal. */
export type Neighbor = Readonly<{ videoId: string; sortKey: string }>;

function toItem(row: Selectable<SyncPlaylistItemsTable>): ItemRecord {
  return Object.freeze({
    videoId: row.video_id,
    present: fromDbBool(row.present),
    sortKey: row.sort_key,
    addedAt: row.added_at,
    seq: row.seq,
    mem: Object.freeze({ seq: row.mem_seq, at: row.mem_at, dev: row.mem_dev }),
    pos: Object.freeze({ seq: row.pos_seq, at: row.pos_at, dev: row.pos_dev }),
  });
}

function itemsOf(oc: OpCtx, playlistId: string) {
  return oc.q
    .selectFrom("sync_playlist_items")
    .selectAll()
    .where("user_id", "=", oc.userId)
    .where("playlist_id", "=", playlistId);
}

/** Rows (present or tombstones) of the given videoIds, by videoId; absent ones are missing from the map. */
export async function findItems(
  oc: OpCtx,
  playlistId: string,
  videoIds: readonly string[],
): Promise<Map<string, ItemRecord>> {
  const rows = await selectInChunks(videoIds, (chunk) =>
    itemsOf(oc, playlistId).where("video_id", "in", chunk).execute(),
  );
  return new Map(rows.map((row) => [row.video_id, toItem(row)]));
}

/** Present items in playlist order (`sort_key`, `video_id`). */
export async function presentItems(oc: OpCtx, playlistId: string): Promise<ItemRecord[]> {
  const rows = await itemsOf(oc, playlistId).where("present", "=", 1).orderBy("sort_key").orderBy("video_id").execute();
  return rows.map(toItem);
}

/** The present item right after `item` in playlist order, skipping `exclude`. */
async function presentAfter(oc: OpCtx, playlistId: string, item: Neighbor, exclude: string | null) {
  let query = itemsOf(oc, playlistId)
    .where("present", "=", 1)
    .where((eb) =>
      eb.or([
        eb("sort_key", ">", item.sortKey),
        eb.and([eb("sort_key", "=", item.sortKey), eb("video_id", ">", item.videoId)]),
      ]),
    );
  if (exclude !== null) query = query.where("video_id", "<>", exclude);
  const row = await query.orderBy("sort_key").orderBy("video_id").limit(1).executeTakeFirst();
  return row ? toItem(row) : null;
}

/** The present item right before `item` in playlist order (`null`: none), skipping `exclude`. */
async function presentBefore(oc: OpCtx, playlistId: string, item: Neighbor | null, exclude: string | null) {
  let query = itemsOf(oc, playlistId).where("present", "=", 1);
  if (item !== null) {
    query = query.where((eb) =>
      eb.or([
        eb("sort_key", "<", item.sortKey),
        eb.and([eb("sort_key", "=", item.sortKey), eb("video_id", "<", item.videoId)]),
      ]),
    );
  }
  if (exclude !== null) query = query.where("video_id", "<>", exclude);
  const row = await query.orderBy("sort_key", "desc").orderBy("video_id", "desc").limit(1).executeTakeFirst();
  return row ? toItem(row) : null;
}

/** The last present item of the playlist (`null`: empty), skipping `exclude`. */
export function lastPresentItem(oc: OpCtx, playlistId: string, exclude: string | null = null) {
  return presentBefore(oc, playlistId, null, exclude);
}

/** The present item right before `item` (its predecessor in playlist order), or `null` when it is the first. */
export function previousPresentItem(oc: OpCtx, playlistId: string, item: Neighbor) {
  return presentBefore(oc, playlistId, item, null);
}

export type Slot = Readonly<{ lower: Neighbor | null; upper: Neighbor | null }>;

/**
 * Where the anchors put an insertion into the present list without `exclude` (DESIGN §3.7): right after `after`,
 * else right before `before`, else at the end. `known` may hold the anchor rows already read.
 */
export async function anchorSlot(
  oc: OpCtx,
  playlistId: string,
  anchors: Readonly<{ after: string | null; before: string | null }>,
  exclude: string | null,
  known: ReadonlyMap<string, ItemRecord> = new Map(),
): Promise<Slot> {
  const anchorRow = async (videoId: string | null) => {
    if (videoId === null || videoId === exclude) return null;
    const row = known.get(videoId) ?? (await findItems(oc, playlistId, [videoId])).get(videoId);
    return row?.present === true ? row : null;
  };
  const after = await anchorRow(anchors.after);
  if (after) return { lower: after, upper: await presentAfter(oc, playlistId, after, exclude) };
  const before = await anchorRow(anchors.before);
  if (before) return { lower: await presentBefore(oc, playlistId, before, exclude), upper: before };
  return { lower: await presentBefore(oc, playlistId, null, exclude), upper: null };
}

/**
 * One row an op writes.
 * - `present`: membership after the op. A present item must be placed by a {@link Placement}; a tombstone keeps its key.
 * - `membership` / `position`: the op writes that register (`seq` of the row, `at`, the author device).
 * - `at`: the time written into those registers (`effAt`; `0` for `playlist.import` appends, DESIGN §3.7).
 * - `addedAt`: `added_at` when the op makes the item present.
 */
export type PlannedItem = Readonly<{
  videoId: string;
  existing: ItemRecord | null;
  present: boolean;
  membership: boolean;
  position: boolean;
  at: number;
  addedAt: number;
}>;

/** A run of placed videoIds, in order, right after `lower` (`null`: at the start) and before `upper`. */
export type Placement = Readonly<{ lower: Neighbor | null; upper: Neighbor | null; videoIds: readonly string[] }>;

type ItemRow = Insertable<SyncPlaylistItemsTable>;

/**
 * Writes the rows of an edit with one `seq` each and returns how many rows were written. Keys come from the
 * placements; when they cannot be issued (a bound is unusable, or a key would be longer than 48 characters), the
 * whole playlist is rebalanced in its final order. Adds every written row to `oc.touched`. Nothing is written for an
 * empty edit.
 */
export async function commitItems(
  oc: OpCtx,
  playlistId: string,
  planned: readonly PlannedItem[],
  placements: readonly Placement[],
): Promise<number> {
  if (planned.length === 0) return 0;
  const byVideo = new Map(planned.map((item) => [item.videoId, item]));
  const keys = new Map<string, string>();
  let rebalance = false;
  for (const placement of placements) {
    const issued = tryKeysBetween(
      placement.lower?.sortKey ?? null,
      placement.upper?.sortKey ?? null,
      placement.videoIds.length,
    );
    if (issued === null) {
      rebalance = true;
      break;
    }
    placement.videoIds.forEach((videoId, index) => keys.set(videoId, issued[index] ?? ""));
  }

  const rows: ItemRow[] = [];
  if (!rebalance) {
    for (const item of planned) rows.push(plannedRow(oc, playlistId, item, keys.get(item.videoId)));
  } else {
    const current = await presentItems(oc, playlistId);
    const order = finalOrder(current, planned, placements);
    const fresh = keysBetween(null, null, order.length);
    const currentByVideo = new Map(current.map((row) => [row.videoId, row]));
    order.forEach((videoId, index) => {
      const key = fresh[index] ?? "";
      const item = byVideo.get(videoId);
      if (item) {
        rows.push(plannedRow(oc, playlistId, item, key));
        return;
      }
      const row = currentByVideo.get(videoId);
      if (row && row.sortKey !== key) rows.push(rekeyedRow(oc, playlistId, row, key));
    });
    for (const item of planned) if (!item.present) rows.push(plannedRow(oc, playlistId, item, undefined));
  }

  await insertInChunks(rows, (chunk) =>
    oc.q
      .insertInto("sync_playlist_items")
      .values(chunk)
      .onConflict((conflict) =>
        conflict.columns(["user_id", "playlist_id", "video_id"]).doUpdateSet((eb) => ({
          present: eb.ref("excluded.present"),
          sort_key: eb.ref("excluded.sort_key"),
          added_at: eb.ref("excluded.added_at"),
          seq: eb.ref("excluded.seq"),
          mem_seq: eb.ref("excluded.mem_seq"),
          mem_at: eb.ref("excluded.mem_at"),
          mem_dev: eb.ref("excluded.mem_dev"),
          pos_seq: eb.ref("excluded.pos_seq"),
          pos_at: eb.ref("excluded.pos_at"),
          pos_dev: eb.ref("excluded.pos_dev"),
        })),
      )
      .execute(),
  );
  const newRows = planned.filter((item) => item.existing === null).length;
  oc.counters.add(ITEM_ROWS_COUNTER, newRows);
  for (const row of rows) oc.touched.items.add(itemKey(playlistId, row.video_id));
  return rows.length;
}

/**
 * The final present order of a rebalanced edit: the items that keep their place (present, not placed, not removed)
 * in their current order, and each placement right after its `lower` (`null`: at the start).
 */
function finalOrder(
  current: readonly ItemRecord[],
  planned: readonly PlannedItem[],
  placements: readonly Placement[],
): string[] {
  const runs = new Map<string | null, string[]>();
  const placed = new Set<string>();
  for (const placement of placements) {
    const lower = placement.lower?.videoId ?? null;
    runs.set(lower, [...(runs.get(lower) ?? []), ...placement.videoIds]);
    for (const videoId of placement.videoIds) placed.add(videoId);
  }
  const removed = new Set(planned.filter((item) => !item.present).map((item) => item.videoId));
  const order = [...(runs.get(null) ?? [])];
  runs.delete(null);
  for (const row of current) {
    if (placed.has(row.videoId) || removed.has(row.videoId)) continue;
    order.push(row.videoId);
    const run = runs.get(row.videoId);
    if (run) {
      order.push(...run);
      runs.delete(row.videoId);
    }
  }
  // A placement whose lower bound is not a fixed present item cannot happen; keep its items anyway, at the end.
  for (const run of runs.values()) order.push(...run);
  return order;
}

function plannedRow(oc: OpCtx, playlistId: string, item: PlannedItem, key: string | undefined): ItemRow {
  const seq = oc.next();
  const existing = item.existing;
  const sortKey = key ?? existing?.sortKey;
  if (sortKey === undefined || (existing === null && !(item.membership && item.position))) {
    throw new Error(`playlist edit: item ${item.videoId} has no key or no registers`);
  }
  const written = { seq, at: item.at, dev: oc.deviceId };
  const mem = item.membership || existing === null ? written : existing.mem;
  // A key change without a position write (rebalance) still moves pos_seq: seq = max(mem_seq, pos_seq).
  const pos =
    item.position || existing === null
      ? written
      : sortKey !== existing.sortKey
        ? { ...existing.pos, seq }
        : existing.pos;
  return {
    user_id: oc.userId,
    playlist_id: playlistId,
    video_id: item.videoId,
    present: toDbBool(item.present),
    sort_key: sortKey,
    added_at: item.membership && item.present ? item.addedAt : (existing?.addedAt ?? item.addedAt),
    seq,
    mem_seq: mem.seq,
    mem_at: mem.at,
    mem_dev: mem.dev,
    pos_seq: pos.seq,
    pos_at: pos.at,
    pos_dev: pos.dev,
  };
}

function rekeyedRow(oc: OpCtx, playlistId: string, row: ItemRecord, key: string): ItemRow {
  const seq = oc.next();
  return {
    user_id: oc.userId,
    playlist_id: playlistId,
    video_id: row.videoId,
    present: toDbBool(row.present),
    sort_key: key,
    added_at: row.addedAt,
    seq,
    mem_seq: row.mem.seq,
    mem_at: row.mem.at,
    mem_dev: row.mem.dev,
    pos_seq: seq,
    pos_at: row.pos.at,
    pos_dev: row.pos.dev,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Composite writes shared by several ops
// ---------------------------------------------------------------------------------------------------------------------

/** A new item row: present, both registers written by the op at `at`. */
export function newItem(videoId: string, at: number, addedAt: number): PlannedItem {
  return Object.freeze({ videoId, existing: null, present: true, membership: true, position: true, at, addedAt });
}

/**
 * Creates a live playlist holding `videoIds` in this order (`playlist.create`, `playlist.import` of an unknown id, a
 * new recovery playlist): header and items are written by the op at `effAt`.
 * @returns `false` when a quota does not allow it; nothing is written then.
 */
export async function createPlaylistWithItems(
  oc: OpCtx,
  playlist: Omit<NewPlaylist, "itemCount">,
  videoIds: readonly string[],
  effAt: number,
): Promise<boolean> {
  const count = videoIds.length;
  if (!(await livePlaylistQuotaAllows(oc))) return false;
  if (!(await itemQuotaAllows(oc, 0, count, count))) return false;
  await insertPlaylist(oc, { ...playlist, itemCount: count }, effAt);
  await commitItems(
    oc,
    playlist.id,
    videoIds.map((videoId) => newItem(videoId, effAt, effAt)),
    [{ lower: null, upper: null, videoIds }],
  );
  return true;
}

/** The op's side of a register comparison. */
export function writerOf(oc: OpCtx, env: OpEnv): RegisterWriter {
  return Object.freeze({ base: env.base, effAt: env.effAt, dev: oc.deviceId });
}
