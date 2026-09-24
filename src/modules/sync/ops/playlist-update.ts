/**
 * `playlist.update {playlistId, name, thumbnailUrl?}` (DESIGN §3.7, API §4.8): the full header, so an absent
 * `thumbnailUrl` means `null`.
 *
 * - No row → `deferred playlist_not_found` (its `playlist.create` has not arrived yet).
 * - A deleted row → `rejected playlist_deleted`.
 * - The header is already this value → no-op (`applied`, no `seq` spent).
 * - Otherwise the header register decides (`wins`, DESIGN §3.4): the op writes the header or is `superseded`.
 */
import { SYNC_OP_KIND_SPECS } from "../../../contract/sync.ts";
import { parsePlaylistOp, playlistNameOrDefault, touchPlaylistOp } from "../playlists/fields.ts";
import { findPlaylist, updatePlaylistHeader, wins, writerOf } from "../playlists/store.ts";
import { applied, deferred, rejected, superseded } from "./types.ts";
import type { OpHandler, ParsedOp } from "./types.ts";

const KIND = "playlist.update";
const SPEC = SYNC_OP_KIND_SPECS[KIND];

export type PlaylistUpdateOp = ParsedOp &
  Readonly<{
    playlistId: string;
    /** Cleaned; empty → the localized default when written. */
    name: string;
    thumbnailUrl: string | null;
  }>;

export const playlistUpdate: OpHandler<PlaylistUpdateOp> = Object.freeze({
  kind: KIND,
  implemented: true,
  journaled: SPEC.journaled,
  parse: (raw) =>
    parsePlaylistOp(raw, KIND, (fields) => ({
      playlistId: fields.playlistId(),
      name: fields.name(),
      thumbnailUrl: fields.thumbnailUrl(),
    })),
  apply: async (oc, op, env) => {
    const playlist = await findPlaylist(oc, op.playlistId);
    if (playlist === null) return deferred("playlist_not_found");
    if (playlist.deleted) return rejected("playlist_deleted");
    const header = { name: playlistNameOrDefault(op.name, oc.locale), thumbnailUrl: op.thumbnailUrl };
    if (header.name === playlist.name && header.thumbnailUrl === playlist.thumbnailUrl) return applied();
    if (!wins(playlist.header, writerOf(oc, env))) return superseded();
    await updatePlaylistHeader(oc, playlist.id, header, env.effAt);
    return applied();
  },
  touch: touchPlaylistOp,
});
