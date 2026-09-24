/**
 * `playlist.item.move {playlistId, videoId, after?, before?}` (DESIGN §3.7, API §4.8): a present item gets a new key
 * between the neighbours the anchors choose in the list without it (after `after`, else before `before`, else at the
 * end), when its position register lets the op win (`wins(pos)`, DESIGN §3.4); otherwise `superseded`. Each item has
 * its own position register, so concurrent moves of different tracks are all kept (DESIGN §3.16).
 *
 * - No row of the playlist → `deferred playlist_not_found`.
 * - A deleted playlist, an item that is absent or a tombstone, or a move that leaves the item where it is → no-op
 *   (`applied`, no `seq` spent).
 */
import { SYNC_OP_KIND_SPECS } from "../../../contract/sync.ts";
import { parsePlaylistOp, touchPlaylistOp } from "../playlists/fields.ts";
import {
  anchorSlot,
  commitItems,
  findItems,
  findPlaylist,
  previousPresentItem,
  wins,
  writerOf,
} from "../playlists/store.ts";
import { applied, deferred, superseded } from "./types.ts";
import type { OpHandler, ParsedOp } from "./types.ts";

const KIND = "playlist.item.move";
const SPEC = SYNC_OP_KIND_SPECS[KIND];

export type PlaylistItemMoveOp = ParsedOp &
  Readonly<{ playlistId: string; videoId: string; after: string | null; before: string | null }>;

export const playlistItemMove: OpHandler<PlaylistItemMoveOp> = Object.freeze({
  kind: KIND,
  implemented: true,
  journaled: SPEC.journaled,
  parse: (raw) =>
    parsePlaylistOp(raw, KIND, (fields) => ({
      playlistId: fields.playlistId(),
      videoId: fields.videoId(),
      after: fields.anchor("after"),
      before: fields.anchor("before"),
    })),
  apply: async (oc, op, env) => {
    const playlist = await findPlaylist(oc, op.playlistId);
    if (playlist === null) return deferred("playlist_not_found");
    if (playlist.deleted) return applied();
    const anchors = [op.after, op.before].filter((videoId) => videoId !== null);
    const rows = await findItems(oc, playlist.id, [op.videoId, ...anchors]);
    const row = rows.get(op.videoId) ?? null;
    if (!row?.present) return applied();
    const slot = await anchorSlot(oc, playlist.id, op, op.videoId, rows);
    // Inserting right after the current predecessor puts the item back where it is.
    const previous = await previousPresentItem(oc, playlist.id, row);
    if ((slot.lower?.videoId ?? null) === (previous?.videoId ?? null)) return applied();
    if (!wins(row.pos, writerOf(oc, env))) return superseded();
    await commitItems(
      oc,
      playlist.id,
      [
        {
          videoId: op.videoId,
          existing: row,
          present: true,
          membership: false,
          position: true,
          at: env.effAt,
          addedAt: row.addedAt,
        },
      ],
      [{ ...slot, videoIds: [op.videoId] }],
    );
    return applied();
  },
  touch: touchPlaylistOp,
});
