/**
 * The registry of op handlers (`handlers[raw.kind]` of DESIGN §3.8), one per kind of API §4.8.
 *
 * A kind without a handler would be a **stub** answering `deferred unknown_kind`: the op is kept by the client and
 * retried when the server version changes (API §2.3), exactly like a kind this server does not know. Since M2 every
 * kind has its handler (T2.1 `like.set`/`bookmark.set`, T2.2 `playlist.*`, T2.3 `play.*`/`history.*`); 0.1.1 adds
 * `track.override.set` and `lyrics.pin.set`.
 */
import { SYNC_OP_KIND_SPECS, SYNC_OP_KINDS } from "../../../contract/sync.ts";
import type { SyncOpKind } from "../../../contract/sync.ts";
import { bookmarkSetHandler } from "./bookmark-set.ts";
import { historyClearHandler } from "./history-clear.ts";
import { historyForgetHandler } from "./history-forget.ts";
import { likeSetHandler } from "./like-set.ts";
import { lyricsPinSetHandler } from "./lyrics-pin-set.ts";
import { playAddHandler } from "./play-add.ts";
import { playBaselineHandler } from "./play-baseline.ts";
import { playlistCreate } from "./playlist-create.ts";
import { playlistDelete } from "./playlist-delete.ts";
import { playlistImport } from "./playlist-import.ts";
import { playlistItemMove } from "./playlist-item-move.ts";
import { playlistItemRemove } from "./playlist-item-remove.ts";
import { playlistItemsAdd } from "./playlist-items-add.ts";
import { playlistItemsReplace } from "./playlist-items-replace.ts";
import { playlistUpdate } from "./playlist-update.ts";
import { trackOverrideSetHandler } from "./track-override-set.ts";
import { deferred, notParsed } from "./types.ts";
import type { OpHandler } from "./types.ts";

/** A handler that has not been implemented yet: `deferred unknown_kind` at parse, nothing written. */
export function stubOpHandler(kind: SyncOpKind): OpHandler {
  return Object.freeze({
    kind,
    implemented: false,
    journaled: SYNC_OP_KIND_SPECS[kind].journaled,
    parse: () => notParsed(deferred("unknown_kind")),
    apply: () => Promise.resolve(deferred("unknown_kind")),
    touch: () => undefined,
  });
}

export type OpHandlers = Readonly<Record<SyncOpKind, OpHandler>>;

/**
 * A registry: the given handlers plus stubs for the other kinds.
 * @throws Error when a handler is registered under another kind than its own.
 */
export function buildOpHandlers(implemented: Readonly<Partial<Record<SyncOpKind, OpHandler>>> = {}): OpHandlers {
  const entries = SYNC_OP_KINDS.map((kind): [SyncOpKind, OpHandler] => {
    const handler = implemented[kind] ?? stubOpHandler(kind);
    if (handler.kind !== kind) throw new Error(`op handler for ${handler.kind} registered as ${kind}`);
    return [kind, handler];
  });
  return Object.freeze(Object.fromEntries(entries) as Record<SyncOpKind, OpHandler>);
}

/** The handlers of this server: every kind of API §4.8 (T2.1 library, T2.2 playlists, T2.3 history). */
export const OP_HANDLERS: OpHandlers = buildOpHandlers({
  "like.set": likeSetHandler,
  "bookmark.set": bookmarkSetHandler,
  "playlist.create": playlistCreate,
  "playlist.update": playlistUpdate,
  "playlist.delete": playlistDelete,
  "playlist.items.add": playlistItemsAdd,
  "playlist.item.remove": playlistItemRemove,
  "playlist.item.move": playlistItemMove,
  "playlist.items.replace": playlistItemsReplace,
  "playlist.import": playlistImport,
  "play.add": playAddHandler,
  "play.baseline": playBaselineHandler,
  "history.clear": historyClearHandler,
  "history.forget": historyForgetHandler,
  "track.override.set": trackOverrideSetHandler,
  "lyrics.pin.set": lyricsPinSetHandler,
});

/** The handler of a raw `kind`, or `null` for a kind this server does not know (→ `deferred unknown_kind`). */
export function opHandlerFor(handlers: OpHandlers, kind: string): OpHandler | null {
  return Object.hasOwn(handlers, kind) ? handlers[kind as SyncOpKind] : null;
}

/** `features.sync.kinds` (API §4.2): only kinds with a real handler; clients create no other ops. */
export function implementedOpKinds(handlers: OpHandlers = OP_HANDLERS): SyncOpKind[] {
  return SYNC_OP_KINDS.filter((kind) => handlers[kind].implemented);
}
