/**
 * `playlist.items.add {playlistId, videoIds[1..500], after?, before?, tracks?}` (DESIGN §3.7, API §4.8).
 *
 * For each videoId (duplicates dropped) that is not present in the playlist: no row, or the membership register lets
 * the op win (`wins(mem)`, DESIGN §3.4) → the item becomes present with both registers written by the op; a present
 * item is left alone. The added items form one block placed by the anchors (after `after`, else before `before`,
 * else at the end; `../playlists/anchors.ts`).
 *
 * - No row of the playlist → `deferred playlist_not_found`.
 * - The playlist is deleted: its author did not know (`base = null` or `base < deleted_seq`) → the tracks go to the
 *   recovery playlist, `redirected` with its id (`../playlists/recovery.ts`); otherwise `rejected playlist_deleted`.
 * - Every candidate lost to a later removal → `superseded`; nothing to add → no-op (`applied`).
 * - Quotas: 10 000 present items per playlist, 100 000 item rows of the user (and 1000 live playlists when a
 *   recovery playlist is created) → `deferred quota_exceeded`.
 */
import { SYNC_OP_KIND_SPECS } from "../../../contract/sync.ts";
import { parsePlaylistOp, touchPlaylistOp } from "../playlists/fields.ts";
import { findRecoveryTarget, recoveryPlaylistName } from "../playlists/recovery.ts";
import {
  anchorSlot,
  commitItems,
  createPlaylistWithItems,
  findItems,
  findPlaylist,
  itemQuotaAllows,
  setItemCount,
  wins,
  writerOf,
} from "../playlists/store.ts";
import type { PlannedItem, PlaylistRecord } from "../playlists/store.ts";
import { applied, deferred, redirected, rejected, superseded } from "./types.ts";
import type { OpCtx, OpEnv, OpHandler, OpOutcome, ParsedOp } from "./types.ts";

const KIND = "playlist.items.add";
const SPEC = SYNC_OP_KIND_SPECS[KIND];

export type PlaylistItemsAddOp = ParsedOp &
  Readonly<{
    playlistId: string;
    /** De-duplicated, in order. */
    videoIds: readonly string[];
    after: string | null;
    before: string | null;
  }>;

/** Adds the op's items to a live playlist: `applied`, `superseded` or `deferred quota_exceeded`. */
async function addItems(oc: OpCtx, playlist: PlaylistRecord, op: PlaylistItemsAddOp, env: OpEnv): Promise<OpOutcome> {
  const anchors = [op.after, op.before].filter((videoId) => videoId !== null);
  const rows = await findItems(oc, playlist.id, [...op.videoIds, ...anchors]);
  const writer = writerOf(oc, env);
  const planned: PlannedItem[] = [];
  let lost = 0;
  for (const videoId of op.videoIds) {
    const row = rows.get(videoId) ?? null;
    if (row?.present === true) continue;
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
  }
  if (planned.length === 0) return lost > 0 ? superseded() : applied();
  const newRows = planned.filter((item) => item.existing === null).length;
  if (!(await itemQuotaAllows(oc, playlist.itemCount, planned.length, newRows))) return deferred("quota_exceeded");
  const slot = await anchorSlot(oc, playlist.id, op, null, rows);
  await commitItems(oc, playlist.id, planned, [{ ...slot, videoIds: planned.map((item) => item.videoId) }]);
  await setItemCount(oc, playlist.id, playlist.itemCount + planned.length);
  return applied();
}

export const playlistItemsAdd: OpHandler<PlaylistItemsAddOp> = Object.freeze({
  kind: KIND,
  implemented: true,
  journaled: SPEC.journaled,
  parse: (raw) =>
    parsePlaylistOp(
      raw,
      KIND,
      (fields) => ({
        playlistId: fields.playlistId(),
        videoIds: fields.videoIds(SPEC.videoIds),
        after: fields.anchor("after"),
        before: fields.anchor("before"),
      }),
      (op) => op.videoIds,
    ),
  apply: async (oc, op, env) => {
    const playlist = await findPlaylist(oc, op.playlistId);
    if (playlist === null) return deferred("playlist_not_found");
    if (!playlist.deleted) return addItems(oc, playlist, op, env);
    if (env.base !== null && playlist.deletedSeq !== null && env.base >= playlist.deletedSeq) {
      return rejected("playlist_deleted");
    }
    const target = await findRecoveryTarget(oc, playlist);
    oc.touched.playlists.add(target.id);
    if (target.playlist !== null) {
      const outcome = await addItems(oc, target.playlist, op, env);
      return outcome.status === "applied" ? redirected(target.id) : outcome;
    }
    const created = await createPlaylistWithItems(
      oc,
      {
        id: target.id,
        name: recoveryPlaylistName(playlist.name, oc.locale),
        browseId: null,
        thumbnailUrl: playlist.thumbnailUrl,
      },
      op.videoIds,
      env.effAt,
    );
    return created ? redirected(target.id) : deferred("quota_exceeded");
  },
  touch: touchPlaylistOp,
});
