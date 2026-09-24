/**
 * `playlist.create {playlistId, name, browseId?, thumbnailUrl?, videoIds?, tracks?}` (DESIGN §3.7, API §4.8).
 *
 * - No row → the playlist is created with its items in the given order (duplicates dropped); the header and every
 *   item are written by this op at `effAt`.
 * - A live row → no-op (`applied`, no `seq` spent): the playlist exists already, e.g. created by a lost response.
 * - A deleted row → `rejected playlist_deleted`: a deleted id is never reused.
 * - Quotas: 1000 live playlists, 100 000 item rows of the user → `deferred quota_exceeded`.
 */
import { SYNC_OP_KIND_SPECS } from "../../../contract/sync.ts";
import { parsePlaylistOp, playlistNameOrDefault, touchPlaylistOp } from "../playlists/fields.ts";
import { createPlaylistWithItems, findPlaylist } from "../playlists/store.ts";
import { applied, deferred, rejected } from "./types.ts";
import type { OpHandler, ParsedOp } from "./types.ts";

const KIND = "playlist.create";
const SPEC = SYNC_OP_KIND_SPECS[KIND];

export type PlaylistCreateOp = ParsedOp &
  Readonly<{
    playlistId: string;
    /** Cleaned; empty → the localized default when written. */
    name: string;
    browseId: string | null;
    thumbnailUrl: string | null;
    /** De-duplicated, in order. */
    videoIds: readonly string[];
  }>;

export const playlistCreate: OpHandler<PlaylistCreateOp> = Object.freeze({
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
        videoIds: fields.optionalVideoIds(SPEC.videoIds),
      }),
      (op) => op.videoIds,
    ),
  apply: async (oc, op, env) => {
    const existing = await findPlaylist(oc, op.playlistId);
    if (existing !== null) return existing.deleted ? rejected("playlist_deleted") : applied();
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
  },
  touch: touchPlaylistOp,
});
