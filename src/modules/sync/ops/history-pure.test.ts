/**
 * Pure rules of the history ops (DESIGN §3.7, §3.11.3, §3.11.5; API §4.8), against `spec/history-totals.vectors.json`
 * so a client can share the same vectors. No database: {@link newPlayStatsAllowed} is exercised with a
 * `RequestCounters` seeded in memory (its `get` never runs `load` once a key is cached), not a real connection.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createRequestCounters } from "./types.ts";
import type { OpCtx } from "./types.ts";
import {
  HISTORY_COUNTERS,
  evictionBatch,
  laterMark,
  newPlayStatsAllowed,
  nextPlayStat,
  planPlayAdd,
} from "./play-add.ts";
import type { PlayForget, PlayStat } from "./play-add.ts";
import { raiseClearMark } from "./history-clear.ts";
import { raiseForget } from "./history-forget.ts";
import { baselineSkips, baselineTotal } from "./play-baseline.ts";

const VECTORS_PATH = fileURLToPath(new URL("../../../../spec/history-totals.vectors.json", import.meta.url));

type Vectors = Readonly<{
  planPlayAdd: Readonly<{
    cases: readonly Readonly<{
      name: string;
      input: Parameters<typeof planPlayAdd>[0];
      expected: ReturnType<typeof planPlayAdd>;
    }>[];
  }>;
  nextPlayStat: Readonly<{
    cases: readonly Readonly<{
      name: string;
      current: PlayStat | null;
      addMs: number;
      playedAt: number | null;
      expected: PlayStat;
    }>[];
  }>;
  laterMark: Readonly<{
    cases: readonly Readonly<{ name: string; a: number | null; b: number | null; expected: number | null }>[];
  }>;
  baselineSkips: Readonly<{
    cases: readonly Readonly<{ name: string; totalBefore: number | null; effAt: number; expected: boolean }>[];
  }>;
  baselineTotal: Readonly<{
    cases: readonly Readonly<{
      name: string;
      mode: "add" | "atLeast";
      currentMs: number;
      totalMs: number;
      expected: number;
    }>[];
  }>;
  raiseClearMark: Readonly<{
    cases: readonly Readonly<{ name: string; current: number | null; mark: number; expected: number | null }>[];
  }>;
  raiseForget: Readonly<{
    cases: readonly Readonly<{
      name: string;
      current: PlayForget | null;
      mark: number;
      resetTotal: boolean;
      expected: ReturnType<typeof raiseForget>;
    }>[];
  }>;
  evictionBatch: Readonly<{ cases: readonly Readonly<{ name: string; cap: number; expected: number }>[] }>;
}>;

const vectors = JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as Vectors;

describe("history vectors (spec/history-totals.vectors.json)", () => {
  test("planPlayAdd: history membership and total counting (DESIGN §3.11.3)", () => {
    for (const c of vectors.planPlayAdd.cases) {
      assert.deepEqual(planPlayAdd(c.input), c.expected, c.name);
    }
  });

  test("nextPlayStat: total and last_played_at after one play", () => {
    for (const c of vectors.nextPlayStat.cases) {
      assert.deepEqual(nextPlayStat(c.current, c.addMs, c.playedAt), c.expected, c.name);
    }
  });

  test("laterMark: the larger of two optional marks", () => {
    for (const c of vectors.laterMark.cases) {
      assert.equal(laterMark(c.a, c.b), c.expected, c.name);
      assert.equal(laterMark(c.a ?? undefined, c.b), c.expected, `${c.name} (a undefined)`);
    }
  });

  test("baselineSkips: a track whose total was reset at or after effAt is skipped", () => {
    for (const c of vectors.baselineSkips.cases) {
      assert.equal(baselineSkips(c.totalBefore, c.effAt), c.expected, c.name);
    }
  });

  test("baselineTotal: add sums, atLeast raises (DESIGN §3.7)", () => {
    for (const c of vectors.baselineTotal.cases) {
      assert.equal(baselineTotal(c.mode, c.currentMs, c.totalMs), c.expected, c.name);
    }
  });

  test("raiseClearMark: the '*' mark only grows, inclusive boundary", () => {
    for (const c of vectors.raiseClearMark.cases) {
      assert.equal(raiseClearMark(c.current, c.mark), c.expected, c.name);
    }
  });

  test("raiseForget: events_before and total_before each grow on their own", () => {
    for (const c of vectors.raiseForget.cases) {
      assert.deepEqual(raiseForget(c.current, c.mark, c.resetTotal), c.expected, c.name);
    }
  });

  test("evictionBatch: at most one request's worth, at most 1% of the cap", () => {
    for (const c of vectors.evictionBatch.cases) {
      assert.equal(evictionBatch(c.cap), c.expected, c.name);
    }
  });
});

describe("newPlayStatsAllowed (DESIGN §3.10: 100000 play_stats quota)", () => {
  async function ctxWithStatsCount(count: number): Promise<OpCtx> {
    const counters = createRequestCounters();
    // Seeded and awaited before use: the counter is cached on first `get`, so the real `load` below (which needs
    // `oc.q`) never runs.
    await counters.get(HISTORY_COUNTERS.stats, () => Promise.resolve(count));
    return { counters } as unknown as OpCtx;
  }

  test("under quota: every wanted row fits", async () => {
    const oc = await ctxWithStatsCount(10);
    assert.equal(await newPlayStatsAllowed(oc, 5), 5);
  });

  test("at the edge: only the remaining room is granted", async () => {
    const oc = await ctxWithStatsCount(99_998);
    assert.equal(await newPlayStatsAllowed(oc, 5), 2);
  });

  test("at quota: nothing new fits, the op still applies", async () => {
    const oc = await ctxWithStatsCount(100_000);
    assert.equal(await newPlayStatsAllowed(oc, 1), 0);
  });

  test("wanted 0 never touches the counter", async () => {
    const counters = createRequestCounters();
    const oc = { counters } as unknown as OpCtx;
    assert.equal(await newPlayStatsAllowed(oc, 0), 0);
  });
});
