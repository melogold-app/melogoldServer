/**
 * Test-only support for the four history op handlers (T2.3): building an {@link OpCtx} by hand and a small runner
 * that replays the relevant parts of the `POST /sync` algorithm (DESIGN §3.8) without `sync.service.ts` (T2.1), which
 * does not exist yet in this worktree (PLAN T2.2 "Зависимость": "до этого обработчики тестируются напрямую через
 * фабрику OpCtx из M0").
 *
 * {@link runHistoryOp} only knows the four kinds T2.3 owns (`play.add`, `play.baseline`, `history.clear`,
 * `history.forget`): the replay check, the journal write to `sync_ops` and the outcome → `OpResult` mapping mirror
 * DESIGN §3.8's `applyOp`, using the same `toOpResult` helper the real runner will use. `tracks[]` upsert and the
 * `base` cursor check are T2.1's job and are not needed by any of these ops (none of them read `env.base`, and the
 * scenarios of `spec/sync-scenarios/history.json` send no `tracks`).
 */
import type { Kysely } from "kysely";
import type { SyncOpKind } from "../../../contract/sync.ts";
import { isSyncOpKind } from "../../../contract/sync.ts";
import type { Database } from "../../../db/index.ts";
import type { Head } from "../../../db/heads.ts";
import { createRequestCounters, newTouchedKeys, toOpResult } from "./types.ts";
import type { OpCtx, OpEnv, ServerLocale, WireOp } from "./types.ts";
import type { OpHandlers } from "./index.ts";

export type TestOpCtxInput = Readonly<{
  q: Kysely<Database>;
  userId: string;
  deviceId: string;
  head: Head;
  now: number;
  locale?: ServerLocale;
  historyRetentionDays?: number;
  historyMaxEvents?: number;
}>;

/** A handmade {@link OpCtx} for a single op or a handful of ops applied one after another in the same `db.write`. */
export function createTestOpCtx(input: TestOpCtxInput): OpCtx {
  let seq = input.head.seq;
  const oc = {
    q: input.q,
    userId: input.userId,
    deviceId: input.deviceId,
    head: input.head,
    now: input.now,
    locale: input.locale ?? "en",
    next: (): number => {
      seq += 1;
      return seq;
    },
    touched: newTouchedKeys(),
    counters: createRequestCounters(),
    env: {
      HISTORY_RETENTION_DAYS: input.historyRetentionDays ?? 400,
      HISTORY_MAX_EVENTS: input.historyMaxEvents ?? 50_000,
    },
    get seq(): number {
      return seq;
    },
  };
  return Object.freeze(oc);
}

function opEnvOf(oc: OpCtx, at: number): OpEnv {
  return { effAt: Math.min(at, oc.now), base: null };
}

/** A `sync_ops` row good enough for {@link runHistoryOp}'s own replay lookup; not `insertSyncOp` (T2.1, unwritten). */
async function journalTestOp(
  oc: OpCtx,
  seq: number,
  raw: WireOp,
  outcome: Readonly<{ status: string; code?: string | null }>,
): Promise<void> {
  await oc.q
    .insertInto("sync_ops")
    .values({
      user_id: oc.userId,
      seq,
      op_id: raw.opId,
      device_id: oc.deviceId,
      device_name: null,
      kind: raw.kind,
      payload: JSON.stringify(raw),
      status: outcome.status,
      code: outcome.code ?? null,
      result: null,
      client_at: raw.at,
      eff_at: opEnvOf(oc, raw.at).effAt,
      base_seq: null,
      pre_image: null,
      server_at: oc.now,
    })
    .execute();
}

/**
 * Applies one raw op through `handlers` (built by {@link import("./index.ts").buildOpHandlers} with only the four
 * history handlers), inside a `db.write` that already ran `lockUser`. Mirrors DESIGN §3.8's `applyOp`:
 * - `play.add` is idempotent through its own PK (`play_events`), so a repeat is recognized there, never journaled;
 * - the other three kinds are recognized through `sync_ops` before `apply` runs, so a repeat never re-executes
 *   non-idempotent logic (`play.baseline mode:"add"` would double-count otherwise);
 * - `touch` runs at every outcome, replayed or not.
 */
export async function runHistoryOp(
  oc: OpCtx,
  handlers: OpHandlers,
  raw: WireOp,
): Promise<
  Readonly<{
    opId: string;
    /** Forward-compatible: the contract keeps this a plain string, not the `OpStatus` union (API §1.3). */
    status: string;
    code: string | null;
    seq: number | null;
    replayed: boolean;
  }>
> {
  const kind: SyncOpKind | null = isSyncOpKind(raw.kind) ? raw.kind : null;

  if (raw.kind === "play.add") {
    const existing = await oc.q
      .selectFrom("play_events")
      .select("seq")
      .where("user_id", "=", oc.userId)
      .where("event_id", "=", raw.opId)
      .executeTakeFirst();
    if (existing !== undefined) {
      if (kind) handlers[kind].touch(raw, oc.touched);
      return { opId: raw.opId, status: "applied", code: null, seq: existing.seq, replayed: true };
    }
  } else {
    const existing = await oc.q
      .selectFrom("sync_ops")
      .select(["seq", "status", "code"])
      .where("user_id", "=", oc.userId)
      .where("op_id", "=", raw.opId)
      .executeTakeFirst();
    if (existing !== undefined) {
      if (kind) handlers[kind].touch(raw, oc.touched);
      return {
        opId: raw.opId,
        status: existing.status,
        code: existing.code,
        seq: existing.seq,
        replayed: true,
      };
    }
  }

  if (kind === null) throw new Error(`op-test-harness: unknown kind "${raw.kind}"`);
  const h = handlers[kind];
  const parsedOp = h.parse(raw);
  if (!parsedOp.ok) {
    h.touch(raw, oc.touched);
    const result = toOpResult(raw.opId, parsedOp.outcome, null, false);
    return { opId: result.opId, status: result.status, code: result.code, seq: null, replayed: false };
  }
  const outcome = await h.apply(oc, parsedOp.value, opEnvOf(oc, parsedOp.value.at));
  h.touch(raw, oc.touched);
  if (outcome.status === "deferred" || outcome.status === "rejected") {
    const result = toOpResult(raw.opId, outcome, null, false);
    return { opId: result.opId, status: result.status, code: result.code, seq: null, replayed: false };
  }
  if (raw.kind === "play.add") {
    const seq = outcome.status === "applied" ? (outcome.seq ?? null) : null;
    return { opId: raw.opId, status: outcome.status, code: null, seq, replayed: false };
  }
  const opSeq = oc.next();
  await journalTestOp(oc, opSeq, raw, outcome);
  return { opId: raw.opId, status: outcome.status, code: null, seq: opSeq, replayed: false };
}
