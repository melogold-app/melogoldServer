/**
 * Op handlers of `POST /sync` (DESIGN §3.7–§3.9): the types every handler implements and the small helpers they
 * share. Frozen after M0 (PLAN, general rules item 2).
 *
 * The runner in `sync.service.ts` (T2.1) drives each op of a request inside **one** `db.write` that started with
 * `lockUser` (DESIGN §3.8):
 *
 * ```
 * h = handlers[raw.kind]                         missing → deferred unknown_kind
 * prev = h.journaled ? findSyncOp(opId) : findPlayEvent(opId)
 *                                                found → replayed: result of prev; h.touch(raw, oc.touched)
 * parsed = h.parse(raw)                          !ok → its outcome (rejected invalid_video_id | deferred invalid_payload)
 * env = { effAt: min(parsed.at, oc.now), base: libSeq of raw.base, or null (other epoch or broken cursor) }
 * outcome = await h.apply(oc, parsed, env)       writes rows with seq = oc.next()
 * h.touch(raw, oc.touched)                       at every status: the response carries the current rows
 * deferred | rejected → done (nothing stored, no seq spent)
 * upsertTracks(oc, parsed.tracks, parsed.trackVideoIds)   lenient metadata, stubs, track quota (DESIGN §3.3, §3.9)
 * h.journaled → sync_ops row with its own seq (payload without tracks, outcome.preImage)
 * ```
 *
 * DESIGN §3.8 journals every applied op, while §3.4 says a no-op spends no `seq`; a handler therefore never calls
 * `next()` for a no-op, so the runner (T2.1) can tell one by `oc.seq` and decide how to record it.
 *
 * **Rules for handlers:**
 * - `parse` is pure: every videoId field that fails `VideoId` → `rejected invalid_video_id`; a missing required
 *   field, a wrong type or a forbidden combination → `deferred invalid_payload`. Metadata never fails an op.
 * - `apply` uses only `oc.q` (no network, no other awaits, docs/database.md) and calls `oc.next()` once per row it
 *   writes. A no-op (the value is already there) writes nothing and calls no `next()`: it spends no `seq`
 *   (DESIGN §3.4), so the runner can tell it by `oc.seq`.
 * - Quotas (DESIGN §3.10) are counted with `oc.counters`: one `COUNT(*)` per key per request, then in memory.
 */
import type { Env } from "../../../config/env.ts";
import type { OpResult, SyncOpEnvelope, SyncOpKind } from "../../../contract/sync.ts";
import type { Head } from "../../../db/heads.ts";
import type { Queryable } from "../../../db/index.ts";
import type { OP_RESULT_CODES, OpResultCode } from "../../../http/error-codes.ts";

/** An op after the route check: `opId`, `kind`, `at` (epoch ms), `base` are valid; other fields are unchecked. */
export type WireOp = SyncOpEnvelope;

/** `OpResult.code` values with status `rejected` (API §2.3). */
export type RejectedOpCode = {
  [C in OpResultCode]: (typeof OP_RESULT_CODES)[C]["status"] extends "rejected" ? C : never;
}[OpResultCode];

/** `OpResult.code` values with status `deferred` (API §2.3). */
export type DeferredOpCode = {
  [C in OpResultCode]: (typeof OP_RESULT_CODES)[C]["status"] extends "deferred" ? C : never;
}[OpResultCode];

/**
 * What a handler decided (DESIGN §3.7 "Результаты ops"). The runner turns it into an `OpResult`.
 * - `applied`: written, or the value was already there. `seq` is the value to report for an op that is not
 *   journaled (`play.add`); a journaled op reports the seq of its `sync_ops` row.
 * - `preImage`: the JSON stored in `sync_ops.pre_image` (`playlist.delete`, `playlist.items.replace`).
 */
export type OpOutcome =
  | Readonly<{ status: "applied"; seq?: number; preImage?: unknown }>
  | Readonly<{ status: "superseded" }>
  | Readonly<{ status: "redirected"; playlistId: string; preImage?: unknown }>
  | Readonly<{ status: "rejected"; code: RejectedOpCode }>
  | Readonly<{ status: "deferred"; code: Exclude<DeferredOpCode, "op_rate_limited"> }>
  | Readonly<{ status: "deferred"; code: "op_rate_limited"; retryAfterSeconds: number }>;

/** The fields every parsed op carries; a handler extends it with its own typed fields. */
export type ParsedOp = Readonly<{
  opId: string;
  kind: SyncOpKind;
  /** `at` in epoch milliseconds (the route already parsed it). */
  at: number;
  /** The raw `tracks` field (`undefined` when absent): `upsertTracks` parses it leniently (DESIGN §3.9). */
  tracks: unknown;
  /** videoIds the op mentions whose `sync_tracks` rows must exist afterwards (a stub when no metadata came). */
  trackVideoIds: readonly string[];
}>;

export type OpParseResult<P extends ParsedOp> =
  | Readonly<{ ok: true; value: P }>
  | Readonly<{ ok: false; outcome: Extract<OpOutcome, { status: "rejected" | "deferred" }> }>;

/** Per-op values computed by the runner (DESIGN §3.8 `env`). */
export type OpEnv = Readonly<{
  /** `min(op.at, oc.now)`: the time conflicts are resolved with (DESIGN §3.4). */
  effAt: number;
  /** `libSeq` of the op's `base` cursor; `null` when the epoch differs or the cursor is broken. */
  base: number | null;
}>;

/**
 * Keys of rows the response must carry as current images (DESIGN §3.8 "Состав ответа", item 2), together with
 * `include`. Bookmarks and items use {@link bookmarkKey} and {@link itemKey}.
 */
export type TouchedKeys = Readonly<{
  likes: Set<string>;
  bookmarks: Set<string>;
  playlists: Set<string>;
  items: Set<string>;
  playStats: Set<string>;
  /** videoIds or `"*"`. */
  playForgets: Set<string>;
  /** videoIds of `track.override.set`. */
  overrides: Set<string>;
  /** videoIds of `lyrics.pin.set`. */
  lyricsPins: Set<string>;
}>;

/**
 * Quota counters of one request (DESIGN §3.10): the first `get` of a key runs `load` (a `COUNT(*)`), later calls
 * return the value kept in memory; `add` adjusts a loaded counter after a write.
 */
export type RequestCounters = Readonly<{
  get(key: string, load: () => Promise<number>): Promise<number>;
  add(key: string, delta: number): void;
}>;

/** Language of the strings the server writes itself: "Без названия"/"Untitled", "(восстановлено)"/"(recovered)". */
export type ServerLocale = "ru" | "en";

/** The state of the write transaction shared by the ops of one request. */
export type OpCtx = Readonly<{
  /** The `db.write` transaction; `lockUser` already ran. */
  q: Queryable;
  userId: string;
  /** The author (`did`): `*_dev` of the registers, `play_events.device_id`. */
  deviceId: string;
  /** The head as locked at the start of the transaction. */
  head: Head;
  /** `ctx.clock.now()` taken once at the start of the transaction. */
  now: number;
  locale: ServerLocale;
  /** The last seq handed out in this transaction (`head.seq` before the first write). */
  seq: number;
  /** Hands out the next seq; call it once per written row. */
  next(): number;
  touched: TouchedKeys;
  counters: RequestCounters;
  env: Pick<Env, "HISTORY_RETENTION_DAYS" | "HISTORY_MAX_EVENTS">;
}>;

/**
 * One op kind. `P` is the handler's parsed op. Methods (not function properties) so that a registry of different
 * handlers type-checks as `OpHandler`.
 */
export type OpHandler<P extends ParsedOp = ParsedOp> = Readonly<{
  kind: SyncOpKind;
  /** `false` only for the M0 stubs; `features.sync.kinds` lists implemented kinds. */
  implemented: boolean;
  /** Recorded in `sync_ops` (all but `play.add`, `SYNC_OP_KIND_SPECS`). */
  journaled: boolean;
  parse(raw: WireOp): OpParseResult<P>;
  apply(oc: OpCtx, op: P, env: OpEnv): Promise<OpOutcome>;
  /** Adds the entity keys the op names to `touched` (also for replays, and at every status). Never throws. */
  touch(raw: WireOp, touched: TouchedKeys): void;
}>;

// ---------------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------------

export const applied = (options: Readonly<{ seq?: number; preImage?: unknown }> = {}): OpOutcome =>
  Object.freeze({ status: "applied", ...options });

export const superseded = (): OpOutcome => Object.freeze({ status: "superseded" });

export const redirected = (playlistId: string, preImage?: unknown): OpOutcome =>
  Object.freeze(
    preImage === undefined ? { status: "redirected", playlistId } : { status: "redirected", playlistId, preImage },
  );

export const rejected = (code: RejectedOpCode): Extract<OpOutcome, { status: "rejected" }> =>
  Object.freeze({ status: "rejected", code });

export const deferred = (
  code: Exclude<DeferredOpCode, "op_rate_limited">,
): Extract<OpOutcome, { status: "deferred" }> => Object.freeze({ status: "deferred", code });

export const opRateLimited = (retryAfterSeconds: number): Extract<OpOutcome, { status: "deferred" }> =>
  Object.freeze({ status: "deferred", code: "op_rate_limited", retryAfterSeconds });

export const parsed = <P extends ParsedOp>(value: P): OpParseResult<P> => Object.freeze({ ok: true, value });

export const notParsed = <P extends ParsedOp>(
  outcome: Extract<OpOutcome, { status: "rejected" | "deferred" }>,
): OpParseResult<P> => Object.freeze({ ok: false, outcome });

/**
 * The `OpResult` of API §4.8 for an outcome.
 * @param seq the seq to report (`sync_ops` row, or `outcome.seq` for `play.add`); `null` for deferred/rejected.
 */
export function toOpResult(opId: string, outcome: OpOutcome, seq: number | null, replayed: boolean): OpResult {
  const deferredOrRejected = outcome.status === "deferred" || outcome.status === "rejected";
  return {
    opId,
    status: outcome.status,
    code: deferredOrRejected ? outcome.code : null,
    seq: deferredOrRejected ? null : seq,
    playlistId: outcome.status === "redirected" ? outcome.playlistId : null,
    retryAfterSeconds:
      outcome.status === "deferred" && outcome.code === "op_rate_limited" ? outcome.retryAfterSeconds : null,
    replayed,
  };
}

export function newTouchedKeys(): TouchedKeys {
  return Object.freeze({
    likes: new Set<string>(),
    bookmarks: new Set<string>(),
    playlists: new Set<string>(),
    items: new Set<string>(),
    playStats: new Set<string>(),
    playForgets: new Set<string>(),
    overrides: new Set<string>(),
    lyricsPins: new Set<string>(),
  });
}

/** Key of a bookmark in {@link TouchedKeys}: browseIds never contain `:` (API §1.6). */
export function bookmarkKey(type: string, browseId: string): string {
  return `${type}:${browseId}`;
}

/** Key of a playlist item in {@link TouchedKeys}. */
export function itemKey(playlistId: string, videoId: string): string {
  return `${playlistId}:${videoId}`;
}

/** Counters of one request (see {@link RequestCounters}). */
export function createRequestCounters(): RequestCounters {
  const values = new Map<string, number>();
  return Object.freeze({
    async get(key: string, load: () => Promise<number>): Promise<number> {
      const known = values.get(key);
      if (known !== undefined) return known;
      const loaded = await load();
      if (!Number.isSafeInteger(loaded) || loaded < 0) throw new RangeError(`counter ${key} loaded ${loaded}`);
      // A concurrent get of the same key may have finished first: keep its value (and its later adds).
      const current = values.get(key);
      if (current !== undefined) return current;
      values.set(key, loaded);
      return loaded;
    },
    add(key: string, delta: number): void {
      const known = values.get(key);
      if (known !== undefined) values.set(key, known + delta);
    },
  });
}

/**
 * `ServerLocale` of a request (API §1.2 `Accept-Language`): `ru` when the first language tag is Russian (`ru`,
 * `ru-RU`, …), otherwise `en`.
 */
export function localeFromAcceptLanguage(header: string | undefined): ServerLocale {
  const first = header?.split(",")[0]?.split(";")[0]?.trim().toLowerCase() ?? "";
  return first === "ru" || first.startsWith("ru-") ? "ru" : "en";
}
