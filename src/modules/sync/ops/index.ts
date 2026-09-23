/**
 * The registry of op handlers (`handlers[raw.kind]` of DESIGN §3.8), one per kind of API §4.8.
 *
 * In M0 every kind is a **stub** that answers `deferred unknown_kind`: the op is kept by the client and retried when
 * the server version changes (API §2.3), exactly like a kind this server does not know. A task that implements a
 * kind (T2.1 `like.set`/`bookmark.set`, T2.2 `playlist.*`, T2.3 `play.*`/`history.*`) replaces its stub here with the
 * handler of its file (one line, through the lead: PLAN, general rules item 1).
 */
import { SYNC_OP_KIND_SPECS, SYNC_OP_KINDS } from "../../../contract/sync.ts";
import type { SyncOpKind } from "../../../contract/sync.ts";
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

/** The handlers of this server (M0: all stubs). */
export const OP_HANDLERS: OpHandlers = buildOpHandlers({});

/** The handler of a raw `kind`, or `null` for a kind this server does not know (→ `deferred unknown_kind`). */
export function opHandlerFor(handlers: OpHandlers, kind: string): OpHandler | null {
  return Object.hasOwn(handlers, kind) ? handlers[kind as SyncOpKind] : null;
}

/** `features.sync.kinds` (API §4.2): only kinds with a real handler; clients create no other ops. */
export function implementedOpKinds(handlers: OpHandlers = OP_HANDLERS): SyncOpKind[] {
  return SYNC_OP_KINDS.filter((kind) => handlers[kind].implemented);
}
