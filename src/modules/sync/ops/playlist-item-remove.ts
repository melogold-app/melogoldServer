/**
 * `playlist.item.remove {playlistId, videoId}` (DESIGN §3.7, API §4.8): a present item whose membership register
 * lets the op win (`wins(mem)`, DESIGN §3.4) becomes a tombstone (`present = 0`, its key kept), otherwise the op is
 * `superseded` (a later add on another device stays).
 *
 * - No row of the playlist → `deferred playlist_not_found`.
 * - A deleted playlist (its items are gone), no item row, or a tombstone already → no-op (`applied`, no `seq`).
 */
import { SYNC_OP_KIND_SPECS } from "../../../contract/sync.ts";
import { parsePlaylistOp, touchPlaylistOp } from "../playlists/fields.ts";
import { commitItems, findItems, findPlaylist, setItemCount, wins, writerOf } from "../playlists/store.ts";
import { applied, deferred, superseded } from "./types.ts";
import type { OpHandler, ParsedOp } from "./types.ts";

const KIND = "playlist.item.remove";
const SPEC = SYNC_OP_KIND_SPECS[KIND];

export type PlaylistItemRemoveOp = ParsedOp & Readonly<{ playlistId: string; videoId: string }>;

export const playlistItemRemove: OpHandler<PlaylistItemRemoveOp> = Object.freeze({
  kind: KIND,
  implemented: true,
  journaled: SPEC.journaled,
  parse: (raw) =>
    parsePlaylistOp(raw, KIND, (fields) => ({ playlistId: fields.playlistId(), videoId: fields.videoId() })),
  apply: async (oc, op, env) => {
    const playlist = await findPlaylist(oc, op.playlistId);
    if (playlist === null) return deferred("playlist_not_found");
    if (playlist.deleted) return applied();
    const row = (await findItems(oc, playlist.id, [op.videoId])).get(op.videoId) ?? null;
    if (!row?.present) return applied();
    if (!wins(row.mem, writerOf(oc, env))) return superseded();
    await commitItems(
      oc,
      playlist.id,
      [
        {
          videoId: op.videoId,
          existing: row,
          present: false,
          membership: true,
          position: false,
          at: env.effAt,
          addedAt: row.addedAt,
        },
      ],
      [],
    );
    await setItemCount(oc, playlist.id, playlist.itemCount - 1);
    return applied();
  },
  touch: touchPlaylistOp,
});
