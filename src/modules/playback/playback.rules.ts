/**
 * The pure decision rules of `PUT`/`DELETE /playback/state` (DESIGN §3.12.3, API §4.9). No I/O: given the row
 * currently stored (or `null`) and the request, these functions compute either a refusal or the row the service
 * should try to write with CAS. Kept separate from `playback.service.ts` so `spec/playback-rules.vectors.json` can
 * exercise the rules directly, on both the vectors and generated cases (`playback.rules.test.ts`).
 *
 * ```
 * eff = min(at, now); s = stored (cleared counts as no active state for rules 1 and 2)
 * 1. s && !s.cleared && s.handoffDeviceId == me && s.handoffSessionId == req.sessionId → handed_off
 * 2. s && !s.cleared && s.deviceId != me && eff < s.stateAt                            → newer_state
 * 3. queue omitted and (no s || s.cleared || (s.deviceId, s.sessionId, s.queueVersion) != (me, sessionId, queueVersion))
 *                                                                                       → queue_required
 *    queue omitted and reused, but index >= the reused queue's length                  → invalid_index
 * 4. rev = max((s?.rev ?? 0) + 1, now); handoff = req.handoffFrom ?? (s alive && s.deviceId == me ? s.handoff : null)
 * ```
 */
import type { TrackDto } from "../../contract/common.ts";

/** The row as it is stored now (decoded), or what `playback.repository.ts` reads. `null`: no row for the user yet. */
export type StoredPlayback = Readonly<{
  rev: number;
  cleared: boolean;
  deviceId: string;
  deviceName: string | null;
  sessionId: string;
  queueVersion: number;
  queue: readonly TrackDto[];
  index: number;
  positionMs: number;
  durationMs: number | null;
  playing: boolean;
  /** `effAt` of the write that produced this row (epoch ms). */
  stateAt: number;
  updatedAt: number;
  handoffDeviceId: string | null;
  handoffSessionId: string | null;
  handoffAt: number | null;
}>;

export type HandoffTriple = Readonly<{
  handoffDeviceId: string | null;
  handoffSessionId: string | null;
  handoffAt: number | null;
}>;

/** The row a successful `write` decision wants stored (still needs the CAS attempt against `stored?.rev`). */
export type NewPlaybackRow = Readonly<{
  rev: number;
  deviceId: string;
  deviceName: string | null;
  sessionId: string;
  queueVersion: number;
  queue: readonly TrackDto[];
  index: number;
  positionMs: number;
  durationMs: number | null;
  playing: boolean;
  stateAt: number;
  updatedAt: number;
}> &
  HandoffTriple;

export type PutInput = Readonly<{
  /** `auth.deviceId` of the caller ("me" in the rules above). */
  deviceId: string;
  /** The caller's current display name (`customName ?? reportedName`), looked up fresh for every attempt. */
  deviceName: string | null;
  sessionId: string;
  queueVersion: number;
  /** `min(client at, now)` is computed here from the raw `at`; pass the client's `at` (epoch ms), not `eff`. */
  atMs: number;
  index: number;
  positionMs: number;
  durationMs: number | null;
  playing: boolean;
  /** Already cleaned (DESIGN §3.9) by `playback.tracks.ts`; `undefined` when the client omitted `queue`. */
  queue?: readonly TrackDto[];
  handoffFrom?: Readonly<{ deviceId: string; sessionId: string }>;
}>;

export type PutDecision =
  | Readonly<{ type: "handed_off" }>
  | Readonly<{ type: "newer_state" }>
  | Readonly<{ type: "queue_required" }>
  | Readonly<{ type: "invalid_index" }>
  | Readonly<{ type: "write"; row: NewPlaybackRow; significant: boolean }>;

/** The stored row for rules 1–2: cleared counts as "nothing there". */
function activeOf(stored: StoredPlayback | null): StoredPlayback | null {
  return stored && !stored.cleared ? stored : null;
}

function resolveHandoff(active: StoredPlayback | null, input: PutInput, effAt: number): HandoffTriple {
  if (input.handoffFrom) {
    return {
      handoffDeviceId: input.handoffFrom.deviceId,
      handoffSessionId: input.handoffFrom.sessionId,
      handoffAt: effAt,
    };
  }
  if (active === null) return { handoffDeviceId: null, handoffSessionId: null, handoffAt: null };
  if (active.deviceId !== input.deviceId) {
    return { handoffDeviceId: null, handoffSessionId: null, handoffAt: null };
  }
  return {
    handoffDeviceId: active.handoffDeviceId,
    handoffSessionId: active.handoffSessionId,
    handoffAt: active.handoffAt,
  };
}

/**
 * DESIGN §3.12.4: whether `playback.updated` must go out for this write (heartbeats that change nothing of this list
 * update the row silently). `prev` is the row as the other devices last saw it (the one this write's CAS read).
 */
function isSignificant(prev: StoredPlayback | null, next: NewPlaybackRow, effAt: number): boolean {
  const prevActive = activeOf(prev);
  if (!prevActive) return true; // new device or session
  if (prevActive.deviceId !== next.deviceId || prevActive.sessionId !== next.sessionId) return true;
  if (prevActive.index !== next.index || prevActive.queueVersion !== next.queueVersion) return true;
  if (prevActive.playing !== next.playing) return true;
  const hadHandoff = prevActive.handoffDeviceId !== null;
  const hasHandoff = next.handoffDeviceId !== null;
  if (hadHandoff !== hasHandoff) return true;
  if (
    hasHandoff &&
    (prevActive.handoffDeviceId !== next.handoffDeviceId || prevActive.handoffSessionId !== next.handoffSessionId)
  ) {
    return true;
  }
  const elapsed = prevActive.playing ? Math.max(0, effAt - prevActive.stateAt) : 0;
  const extrapolated = prevActive.positionMs + elapsed;
  return Math.abs(next.positionMs - extrapolated) > 10_000;
}

/** DESIGN §3.12.3 rules 1–4, for `PUT /playback/state`. Pure: `nowMs` is the caller's clock reading. */
export function decidePlaybackPut(stored: StoredPlayback | null, input: PutInput, nowMs: number): PutDecision {
  const effAt = Math.min(input.atMs, nowMs);
  const active = activeOf(stored);

  if (active !== null) {
    if (active.handoffDeviceId === input.deviceId && active.handoffSessionId === input.sessionId) {
      return { type: "handed_off" };
    }
    if (active.deviceId !== input.deviceId && effAt < active.stateAt) {
      return { type: "newer_state" };
    }
  }

  let queue: readonly TrackDto[];
  if (input.queue === undefined) {
    if (active === null) return { type: "queue_required" };
    const reusable =
      active.deviceId === input.deviceId &&
      active.sessionId === input.sessionId &&
      active.queueVersion === input.queueVersion;
    if (!reusable) return { type: "queue_required" };
    if (input.index >= active.queue.length) return { type: "invalid_index" };
    queue = active.queue;
  } else {
    // The contract already rejects index >= queue.length when queue is provided (PlaybackPut.superRefine).
    queue = input.queue;
  }

  const rev = Math.max((stored?.rev ?? 0) + 1, nowMs);
  const handoff = resolveHandoff(active, input, effAt);
  const row: NewPlaybackRow = {
    rev,
    deviceId: input.deviceId,
    deviceName: input.deviceName,
    sessionId: input.sessionId,
    queueVersion: input.queueVersion,
    queue,
    index: input.index,
    positionMs: input.positionMs,
    durationMs: input.durationMs,
    playing: input.playing,
    stateAt: effAt,
    updatedAt: nowMs,
    ...handoff,
  };
  return { type: "write", row, significant: isSignificant(stored, row, effAt) };
}

export type DeleteInput = Readonly<{
  /** `auth.deviceId` of the caller, used only when there is no row yet (placeholder `device_id`/`session_id`). */
  deviceId: string;
  /** A fresh id the caller generated once (kept out of this pure function so it stays deterministic for tests). */
  fallbackSessionId: string;
}>;

/** DESIGN §3.12.3 `DELETE`: a tombstone. `rev` still only grows (m18), even with no prior row. */
export function decidePlaybackDelete(stored: StoredPlayback | null, input: DeleteInput, nowMs: number): NewPlaybackRow {
  return {
    rev: Math.max((stored?.rev ?? 0) + 1, nowMs),
    deviceId: stored?.deviceId ?? input.deviceId,
    deviceName: stored?.deviceName ?? null,
    sessionId: stored?.sessionId ?? input.fallbackSessionId,
    queueVersion: stored?.queueVersion ?? 0,
    queue: [],
    index: 0,
    positionMs: 0,
    durationMs: null,
    playing: false,
    stateAt: stored?.stateAt ?? nowMs,
    updatedAt: nowMs,
    handoffDeviceId: null,
    handoffSessionId: null,
    handoffAt: null,
  };
}
