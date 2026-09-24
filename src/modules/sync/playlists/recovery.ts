/**
 * The recovery playlist (DESIGN §3.2, §3.7, §3.16): tracks added offline to a playlist that another device deleted
 * meanwhile are not lost, they land in "<name> (восстановлено)" / "<name> (recovered)".
 *
 * - Its id is `uuidv5(<id of the deleted playlist>, NS_MELOGOLD_RECOVERY)`, so every device and every retry arrives
 *   at the same playlist.
 * - When the recovery playlist is deleted too, the next one of the same chain is used:
 *   `uuidv5(<its id>, NS_MELOGOLD_RECOVERY)`, and so on.
 * - `playlist.items.add` is redirected when its author did not know about the deletion (`base < deleted_seq` or
 *   `base = null`); `playlist.import` is always redirected (`../ops/playlist-items-add.ts`, `playlist-import.ts`).
 */
import { STRING_LIMITS } from "../../../contract/limits.ts";
import { recoveryPlaylistId } from "../../../lib/ids.ts";
import { truncateUtf16 } from "../../../lib/strings.ts";
import type { OpCtx, ServerLocale } from "../ops/types.ts";
import { findPlaylist } from "./store.ts";
import type { PlaylistRecord } from "./store.ts";

/** The suffix of a recovery playlist's name, by the language of the request (`Accept-Language`). */
export function recoverySuffix(locale: ServerLocale): string {
  return locale === "ru" ? " (восстановлено)" : " (recovered)";
}

/**
 * `"<name> (восстановлено)"` or `"<name> (recovered)"`, at most 200 UTF-16 units: the name is cut (without splitting
 * a surrogate pair) so that the suffix always stays whole.
 */
export function recoveryPlaylistName(name: string, locale: ServerLocale): string {
  const suffix = recoverySuffix(locale);
  return truncateUtf16(name, STRING_LIMITS.playlistName - suffix.length).trimEnd() + suffix;
}

/** Where a redirected op writes: the live recovery playlist, or the id of the one to create (`playlist: null`). */
export type RecoveryTarget = Readonly<{ id: string; playlist: PlaylistRecord | null }>;

/**
 * Follows the recovery chain of a deleted playlist to the first id that is live or unused. The chain is finite: every
 * step is a deleted row of this user, and uuidv5 does not cycle.
 */
export async function findRecoveryTarget(oc: OpCtx, deleted: PlaylistRecord): Promise<RecoveryTarget> {
  for (let id = recoveryPlaylistId(deleted.id); ; id = recoveryPlaylistId(id)) {
    const playlist = await findPlaylist(oc, id);
    if (playlist === null) return Object.freeze({ id, playlist: null });
    if (!playlist.deleted) return Object.freeze({ id, playlist });
  }
}
