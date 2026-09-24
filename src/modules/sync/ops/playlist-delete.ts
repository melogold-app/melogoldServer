/**
 * `playlist.delete {playlistId}` (DESIGN §3.4, §3.7, API §4.8): deletion is final.
 *
 * - A live row → `deleted = 1`, `deleted_seq` = its new `seq`, every item row removed physically, and
 *   `pre_image = {name, videoIds}` (the present items in order) for the journal (undo is v1.1, DESIGN §11).
 * - Already deleted, or no row → no-op (`applied`, no `seq` spent).
 *
 * Later ops on the playlist: `playlist.items.add` from a device that did not know about the deletion and
 * `playlist.import` go to the recovery playlist (`../playlists/recovery.ts`); the others are rejected or no-ops.
 */
import { SYNC_OP_KIND_SPECS } from "../../../contract/sync.ts";
import { parsePlaylistOp, touchPlaylistOp } from "../playlists/fields.ts";
import { deletePlaylist, findPlaylist, presentItems } from "../playlists/store.ts";
import { applied } from "./types.ts";
import type { OpHandler, ParsedOp } from "./types.ts";

const KIND = "playlist.delete";
const SPEC = SYNC_OP_KIND_SPECS[KIND];

export type PlaylistDeleteOp = ParsedOp & Readonly<{ playlistId: string }>;

/** `sync_ops.pre_image` of a `playlist.delete`. */
export type PlaylistDeletePreImage = Readonly<{ name: string; videoIds: readonly string[] }>;

export const playlistDelete: OpHandler<PlaylistDeleteOp> = Object.freeze({
  kind: KIND,
  implemented: true,
  journaled: SPEC.journaled,
  parse: (raw) => parsePlaylistOp(raw, KIND, (fields) => ({ playlistId: fields.playlistId() })),
  apply: async (oc, op, env) => {
    const playlist = await findPlaylist(oc, op.playlistId);
    if (playlist === null || playlist.deleted) return applied();
    const items = await presentItems(oc, playlist.id);
    await deletePlaylist(oc, playlist.id, env.effAt);
    const preImage: PlaylistDeletePreImage = { name: playlist.name, videoIds: items.map((item) => item.videoId) };
    return applied({ preImage });
  },
  touch: touchPlaylistOp,
});
