/**
 * Test-only `OpCtx` harness for `playlist.*` handlers (PLAN T2.2): "until T2.1 merges, handlers are tested directly
 * through an `OpCtx` factory". `sync.service.ts` (T2.1) is not built yet in this worktree, so this file builds just
 * enough of DESIGN §3.8's write transaction to drive one handler at a time — `lockUser`, a `next()` counter, the
 * touched-keys and counters helpers already in `./types.ts` — and bumps the head like the real runner would. It
 * never becomes part of the server: nothing under `src/modules` imports it, only `*.test.ts` files do.
 *
 * `base` on a wire op is normally resolved by the runner's `parseCursor`/`parseBaseLenient` (T2.1, not built here);
 * {@link libSeqOfBase} is this file's own minimal stand-in, only for building the `env` a test passes to `apply`.
 */
import { bumpHead, lockUser } from "../../../db/heads.ts";
import type { Head } from "../../../db/heads.ts";
import type { Db } from "../../../db/index.ts";
import { createRequestCounters, newTouchedKeys } from "./types.ts";
import type { OpCtx, OpEnv, OpHandler, OpOutcome, ParsedOp, ServerLocale, WireOp } from "./types.ts";

export type OpCtxOptions = Readonly<{
  userId: string;
  deviceId: string;
  /** `oc.now`; defaults to `Date.now()`. */
  now?: number;
  locale?: ServerLocale;
}>;

/**
 * Opens one `db.write` transaction, locks the user, builds an `OpCtx` around it (DESIGN §3.8), and bumps the head
 * when `fn` advanced `oc.seq` past the value `lockUser` returned — exactly what the real runner does around the ops
 * loop. Returns whatever `fn` returns.
 */
export async function withOpCtx<T>(
  db: Pick<Db, "write">,
  options: OpCtxOptions,
  fn: (oc: OpCtx) => Promise<T>,
): Promise<T> {
  return db.write(async (q) => {
    const head: Head = await lockUser(q, options.userId);
    const now = options.now ?? Date.now();
    let seq = head.seq;
    const oc: OpCtx = Object.freeze({
      q,
      userId: options.userId,
      deviceId: options.deviceId,
      head,
      now,
      locale: options.locale ?? "en",
      get seq(): number {
        return seq;
      },
      next: (): number => {
        seq += 1;
        return seq;
      },
      touched: newTouchedKeys(),
      counters: createRequestCounters(),
      env: { HISTORY_RETENTION_DAYS: 400, HISTORY_MAX_EVENTS: 50_000 },
    });
    const result = await fn(oc);
    if (seq !== head.seq) await bumpHead(q, options.userId, seq, now);
    return result;
  });
}

/**
 * A minimal stand-in for the runner's `base` resolution (DESIGN §3.8 `env`): the middle field of a cursor of the
 * form `"<epoch>.<lib>.<hist>"` when its epoch matches `head.epoch`, otherwise `null` (another epoch or a cursor
 * that does not parse) — never throws.
 */
export function libSeqOfBase(base: string | undefined, head: Head): number | null {
  if (base === undefined) return null;
  const parts = base.split(".");
  if (parts.length !== 3 || parts[0] !== head.epoch) return null;
  const lib = Number(parts[1]);
  return Number.isSafeInteger(lib) ? lib : null;
}

/** `env.effAt`/`env.base` for one op, as the runner would compute them (DESIGN §3.8) before calling `apply`. */
export function envOf(oc: OpCtx, at: number, base?: string): OpEnv {
  return { effAt: Math.min(at, oc.now), base: libSeqOfBase(base, oc.head) };
}

/**
 * Runs one op through `handler.parse` then, when it parses, `handler.apply` with the matching `env` — the two DESIGN
 * §3.8 steps a test usually wants together. A parse failure short-circuits with its own outcome, exactly like the
 * real runner.
 */
export async function applyRawOp<P extends ParsedOp>(
  oc: OpCtx,
  handler: OpHandler<P>,
  raw: WireOp,
): Promise<OpOutcome> {
  const parsed = handler.parse(raw);
  if (!parsed.ok) return parsed.outcome;
  return handler.apply(oc, parsed.value, envOf(oc, parsed.value.at, raw.base));
}
