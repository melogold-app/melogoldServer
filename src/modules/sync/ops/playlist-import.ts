/**
 * `playlist.import {playlistId, name, browseId?, thumbnailUrl?, videoIds[0..10000], tracks?}` (DESIGN §3.7,
 * API §4.8): written only by a client merge (DESIGN §3.14), never by ordinary use.
 *
 * - No row → as `playlist.create`: the playlist is created with `videoIds` in order (duplicates dropped).
 * - A live row → the `videoIds` missing from the playlist are appended **at the end, in the given order**, each
 *   with `mem_at = pos_at = 0`: a candidate whose membership register already holds a later value (a real removal
 *   elsewhere) keeps winning over this write (`wins`, DESIGN §3.4), so a server tombstone is never resurrected by an
 *   import. The header is not touched.
 * - A deleted row → always `redirected` to the recovery playlist with every `videoId` of the op (`../playlists/
 *   recovery.ts`), unlike `playlist.items.add` this does not depend on `base`: a merge always imports as if the
 *   deletion was unknown.
 * - Quotas: as `playlist.items.add` (10 000 present items per playlist, 100 000 item rows of the user, 1000 live
 *   playlists for a new playlist or a new recovery playlist) → `deferred quota_exceeded`.
 */
import { SYNC_OP_KIND_SPECS } from "../../../contract/sync.ts";
import { parsePlaylistOp, playlistNameOrDefault, touchPlaylistOp } from "../playlists/fields.ts";
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
import type { PlannedItem, PlaylistRecord, RegisterWriter } from "../playlists/store.ts";
import { applied, deferred, redirected, superseded } from "./types.ts";
import type { OpCtx, OpHandler, OpOutcome, ParsedOp } from "./types.ts";

const KIND = "playlist.import";
const SPEC = SYNC_OP_KIND_SPECS[KIND];

export type PlaylistImportOp = ParsedOp &
  Readonly<{
    playlistId: string;
    /** Cleaned; empty → the localized default when the playlist is created. */
    name: string;
    browseId: string | null;
    thumbnailUrl: string | null;
    /** De-duplicated, in the order to append (or to create with). */
    videoIds: readonly string[];
  }>;

/**
 * Appends the `videoIds` missing from `playlist` at its end, in order: a candidate wins its membership register
 * (`wins`, DESIGN §3.4) against `writer`, so a genuinely absent item (no row) always joins while a tombstone with a
 * later real value does not. `registerAt` is what the written registers carry (`0` for a live import); `addedAt` is
 * the row's own timestamp (always the real import time, DESIGN does not zero it).
 */
async function appendMissing(
  oc: OpCtx,
  playlist: PlaylistRecord,
  videoIds: readonly string[],
  writer: RegisterWriter,
  registerAt: number,
  addedAt: number,
): Promise<OpOutcome> {
  const rows = await findItems(oc, playlist.id, videoIds);
  const planned: PlannedItem[] = [];
  let lost = 0;
  for (const videoId of videoIds) {
    const row = rows.get(videoId) ?? null;
    if (row?.present === true) continue;
    if (row !== null && !wins(row.mem, writer)) {
      lost += 1;
      continue;
    }
    planned.push({ videoId, existing: row, present: true, membership: true, position: true, at: registerAt, addedAt });
  }
  if (planned.length === 0) return lost > 0 ? superseded() : applied();
  const newRows = planned.filter((item) => item.existing === null).length;
  if (!(await itemQuotaAllows(oc, playlist.itemCount, planned.length, newRows))) return deferred("quota_exceeded");
  // No anchors: the slot right after the last present item (`null`: the playlist is empty) and before nothing.
  const slot = await anchorSlot(oc, playlist.id, { after: null, before: null }, null, rows);
  await commitItems(oc, playlist.id, planned, [{ ...slot, videoIds: planned.map((item) => item.videoId) }]);
  await setItemCount(oc, playlist.id, playlist.itemCount + planned.length);
  return applied();
}

export const playlistImport: OpHandler<PlaylistImportOp> = Object.freeze({
  kind: KIND,
  implemented: true,
  journaled: SPEC.journaled,
  parse: (raw) =>
    parsePlaylistOp(
      raw,
      KIND,
      (fields) => ({
        playlistId: fields.playlistId(),
        name: fields.name(),
        browseId: fields.browseId(),
        thumbnailUrl: fields.thumbnailUrl(),
        videoIds: fields.videoIds(SPEC.videoIds),
      }),
      (op) => op.videoIds,
    ),
  apply: async (oc, op, env) => {
    const existing = await findPlaylist(oc, op.playlistId);
    if (existing === null) {
      const created = await createPlaylistWithItems(
        oc,
        {
          id: op.playlistId,
          name: playlistNameOrDefault(op.name, oc.locale),
          browseId: op.browseId,
          thumbnailUrl: op.thumbnailUrl,
        },
        op.videoIds,
        env.effAt,
      );
      return created ? applied() : deferred("quota_exceeded");
    }
    if (existing.deleted) {
      const target = await findRecoveryTarget(oc, existing);
      oc.touched.playlists.add(target.id);
      if (target.playlist !== null) {
        const outcome = await appendMissing(oc, target.playlist, op.videoIds, writerOf(oc, env), env.effAt, env.effAt);
        return outcome.status === "applied" ? redirected(target.id) : outcome;
      }
      const created = await createPlaylistWithItems(
        oc,
        {
          id: target.id,
          name: recoveryPlaylistName(existing.name, oc.locale),
          browseId: null,
          thumbnailUrl: existing.thumbnailUrl,
        },
        op.videoIds,
        env.effAt,
      );
      return created ? redirected(target.id) : deferred("quota_exceeded");
    }
    const zeroWriter = writerOf(oc, { base: env.base, effAt: 0 });
    return appendMissing(oc, existing, op.videoIds, zeroWriter, 0, env.effAt);
  },
  touch: touchPlaylistOp,
});
