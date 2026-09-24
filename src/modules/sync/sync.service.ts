/**
 * The sync service (DESIGN §3.8, API §4.7–§4.8): `POST /sync`, `GET /sync/summary`, `POST /sync/merge-plan`.
 *
 * **`POST /sync`** has two transactions (M13):
 *
 * 1. With ops, a **write** transaction: `lockUser` first, the cursor checked against the locked head (400/410 roll
 *    everything back), then every op in order through its handler (the runner below), the journal `sync_ops`, and
 *    `bumpHead` when a `seq` was spent. After commit: `sync.changed {cursor}` to the other devices (coalesced 2 s)
 *    and `touchLastSync`.
 * 2. A **read** transaction (one snapshot of the head and the rows): the page, the current rows of the keys the ops
 *    touched and of `include`, parents and tracks (`page.ts`). A pull at the head without ops or `include` answers
 *    an empty page without reading tables.
 *
 * **The runner** (`ops/types.ts`), per op: the handler of `kind` (none → `deferred unknown_kind`); an earlier result
 * of the same `opId` → that result with `replayed: true` (`sync_ops` for journaled kinds, `play_events` for
 * `play.add`); `parse` (→ `rejected invalid_video_id` / `deferred invalid_payload`); `apply` with
 * `effAt = min(at, now)` and `base` = libSeq of `SyncOp.base`; the op's keys go to `touched` at every status;
 * `deferred`/`rejected` stop there (nothing stored, no `seq`); then the metadata of `tracks[]` (`tracks.ts`); a
 * journaled op that wrote something gets its `sync_ops` row with its own `seq` (payload without `tracks`).
 *
 * An op that wrote nothing — the value was already there, or it lost every register (`superseded`) — spends no
 * `seq` (DESIGN §3.4) and therefore has no `sync_ops` row either (its primary key is the `seq`): a repeat of it is
 * evaluated again and gives the same kind of answer, without `replayed`. Only ops with an effect are journaled,
 * which is what idempotency needs: an effect is never applied twice.
 *
 * **Work budget** (API §1.9): Σ(`videoIds` + `entries` + `tracks`) over the ops ≤ 20 000, else `413`.
 */
import { z } from "zod";
import type { AppContext } from "../../context.ts";
import { SYNC_LIMITS } from "../../contract/limits.ts";
import { SYNC_OP_KINDS, SYNC_STREAM_VALUES } from "../../contract/sync.ts";
import type {
  MergePlanRequest,
  MergePlanResponse,
  OpResult,
  SyncInclude,
  SyncRequestEnvelope,
  SyncResponse,
  SyncSummary,
} from "../../contract/sync.ts";
import { selectInChunks } from "../../db/batch.ts";
import { jsonCodec } from "../../db/codecs.ts";
import { bumpHead, lockUser, readHead } from "../../db/heads.ts";
import type { Queryable } from "../../db/index.ts";
import type { RequestAuth } from "../../http/auth-guard.ts";
import { AppError } from "../../http/errors.ts";
import { formatIso } from "../../lib/time.ts";
import { atHead, baseSeq, formatCursor, parseCursor } from "./cursor.ts";
import { bookmarkSetHandler } from "./ops/bookmark-set.ts";
import { OP_HANDLERS, buildOpHandlers, opHandlerFor } from "./ops/index.ts";
import type { OpHandlers } from "./ops/index.ts";
import { likeSetHandler } from "./ops/like-set.ts";
import { bookmarkKey, createRequestCounters, deferred, newTouchedKeys, toOpResult } from "./ops/types.ts";
import type { OpCtx, OpEnv, OpHandler, OpOutcome, ParsedOp, ServerLocale, TouchedKeys, WireOp } from "./ops/types.ts";
import { emptyArrays, newResponseRows, readForcedRows, readPage, readSatellites, responseArrays } from "./page.ts";
import { planMerge } from "./playlists/merge-plan.ts";
import { readSummary } from "./summary.ts";
import { upsertTracks } from "./tracks.ts";
import { effectiveAt } from "./wins.ts";

// ---------------------------------------------------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------------------------------------------------

/** The kinds this task implements (T2.1). */
export const LIBRARY_OP_HANDLERS = Object.freeze({
  "like.set": likeSetHandler,
  "bookmark.set": bookmarkSetHandler,
});

/**
 * The registry `/sync` runs: every implemented handler of `ops/index.ts` plus {@link LIBRARY_OP_HANDLERS}, stubs for
 * the rest. Once `ops/index.ts` registers these two kinds itself, the result is the same.
 */
export function syncOpHandlers(base: OpHandlers = OP_HANDLERS): OpHandlers {
  const implemented: Partial<Record<string, OpHandler>> = {};
  for (const kind of SYNC_OP_KINDS) if (base[kind].implemented) implemented[kind] = base[kind];
  return buildOpHandlers({ ...implemented, ...LIBRARY_OP_HANDLERS });
}

// ---------------------------------------------------------------------------------------------------------------------
// Journal (`sync_ops`)
// ---------------------------------------------------------------------------------------------------------------------

const jsonValue = z.json();
type JsonValue = z.output<typeof jsonValue>;

/** `sync_ops.payload`: the op without `opId`, `kind`, `at`, `base` (columns of their own) and `tracks`. */
const payloadCodec = jsonCodec(z.record(z.string(), jsonValue), "sync_ops.payload");
/** `sync_ops.result`: what a replay needs besides status and code — the recovery playlist of `redirected`. */
const resultCodec = jsonCodec(z.object({ playlistId: z.string() }), "sync_ops.result");
/** `sync_ops.pre_image` (`playlist.delete`, `playlist.items.replace`: the state before, for undo in v1.1). */
const preImageCodec = jsonCodec(jsonValue, "sync_ops.pre_image");

const NOT_IN_PAYLOAD = new Set(["opId", "kind", "at", "base", "tracks"]);

/** The fields of an op came from `JSON.parse` (the route only transformed `at`, which is left out). */
function journalPayload(raw: WireOp): Record<string, JsonValue> {
  const payload: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!NOT_IN_PAYLOAD.has(key) && value !== undefined) payload[key] = value as JsonValue;
  }
  return payload;
}

/** The results of earlier requests for the opIds of this one (`replayed: true`). */
async function findPrevious(
  q: Queryable,
  userId: string,
  ops: readonly WireOp[],
  handlers: OpHandlers,
): Promise<Map<string, OpResult>> {
  const journaled: string[] = [];
  const events: string[] = [];
  for (const op of ops) {
    const handler = opHandlerFor(handlers, op.kind);
    if (handler) (handler.journaled ? journaled : events).push(op.opId);
  }
  const previous = new Map<string, OpResult>();
  const opRows = await selectInChunks(journaled, (chunk) =>
    q
      .selectFrom("sync_ops")
      .select(["op_id", "seq", "status", "code", "result"])
      .where("user_id", "=", userId)
      .where("op_id", "in", chunk)
      .execute(),
  );
  for (const row of opRows) {
    previous.set(row.op_id, {
      opId: row.op_id,
      status: row.status,
      code: row.code,
      seq: row.seq,
      playlistId: resultCodec.decodeNullable(row.result)?.playlistId ?? null,
      retryAfterSeconds: null,
      replayed: true,
    });
  }
  const eventRows = await selectInChunks(events, (chunk) =>
    q
      .selectFrom("play_events")
      .select(["event_id", "seq"])
      .where("user_id", "=", userId)
      .where("event_id", "in", chunk)
      .execute(),
  );
  for (const row of eventRows) {
    previous.set(row.event_id, {
      opId: row.event_id,
      status: "applied",
      code: null,
      seq: row.seq,
      playlistId: null,
      retryAfterSeconds: null,
      replayed: true,
    });
  }
  return previous;
}

// ---------------------------------------------------------------------------------------------------------------------
// The write transaction
// ---------------------------------------------------------------------------------------------------------------------

type WriteOutcome = Readonly<{
  results: OpResult[];
  touched: TouchedKeys;
  /** The head after the ops, when they spent a `seq`: the cursor of `sync.changed`. */
  headCursor: string | null;
}>;

type WriteInput = Readonly<{
  auth: RequestAuth;
  cursor: string;
  ops: readonly WireOp[];
  locale: ServerLocale;
}>;

/** Σ(`videoIds` + `entries` + `tracks`) of the ops (API §1.9); fields that are not arrays count 0. */
export function workUnits(ops: readonly WireOp[]): number {
  let units = 0;
  for (const op of ops) {
    for (const value of [op.videoIds, op.entries, op.tracks]) if (Array.isArray(value)) units += value.length;
  }
  return units;
}

async function applyOps(
  ctx: AppContext,
  handlers: OpHandlers,
  q: Queryable,
  { auth, cursor, ops, locale }: WriteInput,
): Promise<WriteOutcome> {
  const head = await lockUser(q, auth.userId);
  parseCursor(cursor, head);
  const now = ctx.clock.now();
  let seq = head.seq;
  const oc: OpCtx = Object.freeze({
    q,
    userId: auth.userId,
    deviceId: auth.deviceId,
    head,
    now,
    locale,
    get seq() {
      return seq;
    },
    next: () => (seq += 1),
    touched: newTouchedKeys(),
    counters: createRequestCounters(),
    env: { HISTORY_RETENTION_DAYS: ctx.env.HISTORY_RETENTION_DAYS, HISTORY_MAX_EVENTS: ctx.env.HISTORY_MAX_EVENTS },
  });

  let deviceName: string | null | undefined;
  const journal = async (opSeq: number, raw: WireOp, env: OpEnv, outcome: OpOutcome): Promise<void> => {
    if (deviceName === undefined) {
      const device = await q
        .selectFrom("devices")
        .select(["custom_name", "reported_name"])
        .where("id", "=", auth.deviceId)
        .where("user_id", "=", auth.userId)
        .executeTakeFirst();
      deviceName = device ? (device.custom_name ?? device.reported_name) : null;
    }
    const preImage = outcome.status === "applied" || outcome.status === "redirected" ? outcome.preImage : undefined;
    await q
      .insertInto("sync_ops")
      .values({
        user_id: auth.userId,
        seq: opSeq,
        op_id: raw.opId,
        device_id: auth.deviceId,
        device_name: deviceName,
        kind: raw.kind,
        payload: payloadCodec.encode(journalPayload(raw)),
        status: outcome.status,
        code: null,
        result: outcome.status === "redirected" ? resultCodec.encode({ playlistId: outcome.playlistId }) : null,
        client_at: raw.at,
        eff_at: env.effAt,
        base_seq: env.base,
        pre_image: preImage === undefined ? null : preImageCodec.encode(preImage as JsonValue),
        server_at: now,
      })
      .execute();
  };

  const previous = await findPrevious(q, auth.userId, ops, handlers);
  const results: OpResult[] = [];
  for (const raw of ops) {
    const handler = opHandlerFor(handlers, raw.kind);
    if (handler === null) {
      results.push(toOpResult(raw.opId, deferred("unknown_kind"), null, false));
      continue;
    }
    const replay = previous.get(raw.opId);
    if (replay) {
      handler.touch(raw, oc.touched);
      results.push(replay);
      continue;
    }
    results.push(await applyOne(oc, handler, raw, journal));
  }
  if (seq === head.seq) return { results, touched: oc.touched, headCursor: null };
  await bumpHead(q, auth.userId, seq, now);
  return { results, touched: oc.touched, headCursor: formatCursor(head.epoch, seq, seq) };
}

async function applyOne(
  oc: OpCtx,
  handler: OpHandler,
  raw: WireOp,
  journal: (seq: number, raw: WireOp, env: OpEnv, outcome: OpOutcome) => Promise<void>,
): Promise<OpResult> {
  const parsedOp = handler.parse(raw);
  if (!parsedOp.ok) {
    handler.touch(raw, oc.touched);
    return toOpResult(raw.opId, parsedOp.outcome, null, false);
  }
  const op: ParsedOp = parsedOp.value;
  const env: OpEnv = { effAt: effectiveAt(op.at, oc.now), base: baseSeq(raw.base, oc.head) };
  const before = oc.seq;
  const outcome = await handler.apply(oc, op, env);
  handler.touch(raw, oc.touched);
  if (outcome.status === "deferred" || outcome.status === "rejected") return toOpResult(raw.opId, outcome, null, false);
  await upsertTracks(oc, op.tracks, op.trackVideoIds);
  if (!handler.journaled) {
    return toOpResult(raw.opId, outcome, outcome.status === "applied" ? (outcome.seq ?? null) : null, false);
  }
  if (oc.seq === before) return toOpResult(raw.opId, outcome, null, false);
  const opSeq = oc.next();
  await journal(opSeq, raw, env, outcome);
  return toOpResult(raw.opId, outcome, opSeq, false);
}

// ---------------------------------------------------------------------------------------------------------------------
// The read transaction
// ---------------------------------------------------------------------------------------------------------------------

/** The keys whose current rows the response carries: touched by the ops, plus `include`; `null` when none. */
export function forcedKeys(touched: TouchedKeys | null, include: SyncInclude | undefined): TouchedKeys | null {
  if (touched === null && include === undefined) return null;
  const keys = newTouchedKeys();
  if (touched) {
    for (const name of ["likes", "bookmarks", "playlists", "items", "playStats", "playForgets"] as const) {
      for (const key of touched[name]) keys[name].add(key);
    }
  }
  for (const videoId of include?.likes ?? []) keys.likes.add(videoId);
  for (const id of include?.playlists ?? []) keys.playlists.add(id);
  for (const bookmark of include?.bookmarks ?? []) keys.bookmarks.add(bookmarkKey(bookmark.type, bookmark.browseId));
  for (const videoId of include?.playStats ?? []) keys.playStats.add(videoId);
  return keys;
}

// ---------------------------------------------------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------------------------------------------------

/** `POST /sync/merge-plan`: T2.2's `planMerge` (`playlists/merge-plan.ts`). */
export type MergePlanner = (
  ctx: AppContext,
  auth: RequestAuth,
  request: MergePlanRequest,
) => Promise<MergePlanResponse>;

/** T2.2's `planMerge` over the user's playlists, in a read transaction: nothing is written (API §4.7). */
export const playlistMergePlanner: MergePlanner = (ctx, auth, request) =>
  ctx.db.read((q) => planMerge(q, auth.userId, request));

export type SyncServiceOptions = Readonly<{
  /** Default: {@link syncOpHandlers}. */
  handlers?: OpHandlers;
  /** Default: {@link playlistMergePlanner}. */
  planMerge?: MergePlanner;
}>;

export type SyncService = Readonly<{
  handlers: OpHandlers;
  sync(auth: RequestAuth, request: SyncRequestEnvelope, locale: ServerLocale): Promise<SyncResponse>;
  summary(auth: RequestAuth): Promise<SyncSummary>;
  mergePlan(auth: RequestAuth, request: MergePlanRequest): Promise<MergePlanResponse>;
}>;

export function createSyncService(ctx: AppContext, options: SyncServiceOptions = {}): SyncService {
  const handlers = options.handlers ?? syncOpHandlers();
  const mergePlanner = options.planMerge ?? playlistMergePlanner;

  async function sync(auth: RequestAuth, request: SyncRequestEnvelope, locale: ServerLocale): Promise<SyncResponse> {
    const ops = request.ops ?? [];
    if (workUnits(ops) > SYNC_LIMITS.maxWorkUnitsPerRequest) throw new AppError("payload_too_large");
    const streams = request.streams ?? SYNC_STREAM_VALUES;
    const limit = request.limit ?? SYNC_LIMITS.defaultPageSize;

    let written: WriteOutcome | null = null;
    if (ops.length > 0) {
      const input: WriteInput = { auth, cursor: request.cursor, ops, locale };
      written = await ctx.db.write((q) => applyOps(ctx, handlers, q, input));
      if (written.headCursor !== null) {
        ctx.live.publishCoalesced(
          auth.userId,
          "sync.changed",
          { cursor: written.headCursor },
          { excludeDeviceId: auth.deviceId },
        );
      }
      ctx.devices.touchLastSync(auth.deviceId);
    }
    const results = written?.results ?? [];
    const forced = forcedKeys(written?.touched ?? null, request.include);

    return ctx.db.read(async (q) => {
      const head = await readHead(q, auth.userId);
      const since = parseCursor(request.cursor, head);
      if (forced === null && atHead(since, head.seq, streams)) {
        return {
          results,
          cursor: formatCursor(head.epoch, since.lib, since.hist),
          hasMore: false,
          serverTime: formatIso(ctx.clock.now()),
          ...emptyArrays(),
        };
      }
      const rows = newResponseRows();
      const bounds = await readPage(q, auth.userId, { since, limit, headSeq: head.seq, streams }, rows);
      if (forced !== null) await readForcedRows(q, auth.userId, forced, rows);
      await readSatellites(q, auth.userId, bounds.libEnd, rows);
      return {
        results,
        cursor: formatCursor(head.epoch, bounds.libEnd, bounds.histEnd),
        hasMore: bounds.hasMore,
        serverTime: formatIso(ctx.clock.now()),
        ...responseArrays(rows),
      };
    });
  }

  return Object.freeze({
    handlers,
    sync,
    summary: (auth: RequestAuth) => ctx.db.read((q) => readSummary(q, auth.userId, ctx.clock.now())),
    mergePlan: (auth: RequestAuth, request: MergePlanRequest) => mergePlanner(ctx, auth, request),
  });
}
