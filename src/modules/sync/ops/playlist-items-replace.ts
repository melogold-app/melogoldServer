/**
 * `playlist.items.replace {playlistId, videoIds[0..10000], tracks?}` (DESIGN §3.7, API §4.8): the mirror of a YouTube
 * playlist. The new list (duplicates dropped) is applied item by item, each register deciding on its own, so a
 * later manual add on another device survives an older automatic sync (DESIGN §3.16):
 *
 * - **membership:** an item of the list that is absent or a tombstone becomes present when `wins(mem)`; a present
 *   item missing from the list becomes a tombstone when `wins(mem)`;
 * - **order:** the present items of the list that lie on a longest increasing subsequence of their current keys
 *   keep their keys (`../playlists/lis.ts`); every other item of the list is placed right after the nearest
 *   preceding kept item (at the start when there is none) in the order of the list, a present one only when
 *   `wins(pos)`.
 *
 * `pre_image` = the present list before the op. No row of the playlist → `deferred playlist_not_found`; a deleted
 * playlist → `rejected playlist_deleted` (an automatic mirror does not resurrect a playlist the user deleted; manual
 * adds of an offline device are redirected by `playlist.items.add` on their own). Every change lost → `superseded`;
 * nothing to change → no-op (`applied`). Quotas as in `playlist.items.add` → `deferred quota_exceeded`.
 */
import { SYNC_OP_KIND_SPECS } from "../../../contract/sync.ts";
import { parsePlaylistOp, touchPlaylistOp } from "../playlists/fields.ts";
import { longestIncreasingSubsequence } from "../playlists/lis.ts";
import {
  commitItems,
  findItems,
  findPlaylist,
  itemQuotaAllows,
  presentItems,
  setItemCount,
  wins,
  writerOf,
} from "../playlists/store.ts";
import type { ItemRecord, Placement, PlannedItem } from "../playlists/store.ts";
import { applied, deferred, rejected, superseded } from "./types.ts";
import type { OpHandler, ParsedOp } from "./types.ts";

const KIND = "playlist.items.replace";
const SPEC = SYNC_OP_KIND_SPECS[KIND];

export type PlaylistItemsReplaceOp = ParsedOp &
  Readonly<{
    playlistId: string;
    /** De-duplicated, in order: the new list. */
    videoIds: readonly string[];
  }>;

/** `sync_ops.pre_image` of a `playlist.items.replace`: the present list before the op. */
export type PlaylistReplacePreImage = Readonly<{ videoIds: readonly string[] }>;

export const playlistItemsReplace: OpHandler<PlaylistItemsReplaceOp> = Object.freeze({
  kind: KIND,
  implemented: true,
  journaled: SPEC.journaled,
  parse: (raw) =>
    parsePlaylistOp(
      raw,
      KIND,
      (fields) => ({ playlistId: fields.playlistId(), videoIds: fields.videoIds(SPEC.videoIds) }),
      (op) => op.videoIds,
    ),
  apply: async (oc, op, env) => {
    const playlist = await findPlaylist(oc, op.playlistId);
    if (playlist === null) return deferred("playlist_not_found");
    if (playlist.deleted) return rejected("playlist_deleted");
    const writer = writerOf(oc, env);
    const current = await presentItems(oc, playlist.id);
    const preImage: PlaylistReplacePreImage = { videoIds: current.map((item) => item.videoId) };
    const currentIndex = new Map(current.map((item, index) => [item.videoId, index]));
    const target = new Set(op.videoIds);
    const planned: PlannedItem[] = [];
    let lost = 0;

    // Membership: present items missing from the new list.
    let removed = 0;
    for (const item of current) {
      if (target.has(item.videoId)) continue;
      if (!wins(item.mem, writer)) {
        lost += 1;
        continue;
      }
      planned.push({ ...unchanged(item), present: false, membership: true, at: env.effAt });
      removed += 1;
    }

    // Order: present items of the new list that are off the LIS move (when their position register allows it).
    const kept = op.videoIds.filter((videoId) => currentIndex.has(videoId));
    const onLis = new Set(
      longestIncreasingSubsequence(kept.map((videoId) => currentIndex.get(videoId) ?? 0)).map(
        (index) => kept[index] ?? "",
      ),
    );
    const placed = new Set<string>();
    for (const videoId of kept) {
      if (onLis.has(videoId)) continue;
      const item = current[currentIndex.get(videoId) ?? -1];
      if (item === undefined) continue;
      if (!wins(item.pos, writer)) {
        lost += 1;
        continue;
      }
      planned.push({ ...unchanged(item), position: true, at: env.effAt });
      placed.add(videoId);
    }

    // Membership: items of the new list that are absent or tombstones.
    const missing = op.videoIds.filter((videoId) => !currentIndex.has(videoId));
    const tombstones = await findItems(oc, playlist.id, missing);
    let added = 0;
    for (const videoId of missing) {
      const row = tombstones.get(videoId) ?? null;
      if (row !== null && !wins(row.mem, writer)) {
        lost += 1;
        continue;
      }
      planned.push({
        videoId,
        existing: row,
        present: true,
        membership: true,
        position: true,
        at: env.effAt,
        addedAt: env.effAt,
      });
      placed.add(videoId);
      added += 1;
    }

    if (planned.length === 0) return lost > 0 ? superseded() : applied({ preImage });
    const presentDelta = added - removed;
    const newRows = planned.filter((item) => item.existing === null).length;
    if (!(await itemQuotaAllows(oc, playlist.itemCount, presentDelta, newRows))) return deferred("quota_exceeded");
    await commitItems(oc, playlist.id, planned, placements(op.videoIds, current, onLis, placed, planned));
    if (presentDelta !== 0) await setItemCount(oc, playlist.id, playlist.itemCount + presentDelta);
    return applied({ preImage });
  },
  touch: touchPlaylistOp,
});

/** A planned write of `item` that changes nothing yet (the caller overrides what the op writes). */
function unchanged(item: ItemRecord): PlannedItem {
  return {
    videoId: item.videoId,
    existing: item,
    present: item.present,
    membership: false,
    position: false,
    at: 0,
    addedAt: item.addedAt,
  };
}

/**
 * Runs of placed items: each run of the new list goes right after the nearest preceding LIS item (`null`: at the
 * start) and before the next item that keeps its place in the current order.
 */
function placements(
  list: readonly string[],
  current: readonly ItemRecord[],
  onLis: ReadonlySet<string>,
  placed: ReadonlySet<string>,
  planned: readonly PlannedItem[],
): Placement[] {
  const moving = new Set(planned.map((item) => item.videoId));
  // Items that keep their keys: LIS items, and present items the op could not move or remove.
  const fixed = current.filter((item) => !moving.has(item.videoId));
  const fixedIndex = new Map(fixed.map((item, index) => [item.videoId, index]));
  const result: Placement[] = [];
  let lower: ItemRecord | null = null;
  let run: string[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const upper = lower === null ? fixed[0] : fixed[(fixedIndex.get(lower.videoId) ?? fixed.length) + 1];
    result.push({ lower, upper: upper ?? null, videoIds: run });
    run = [];
  };
  const byVideo = new Map(current.map((item) => [item.videoId, item]));
  for (const videoId of list) {
    if (onLis.has(videoId)) {
      flush();
      lower = byVideo.get(videoId) ?? null;
    } else if (placed.has(videoId)) {
      run.push(videoId);
    }
  }
  flush();
  return result;
}
