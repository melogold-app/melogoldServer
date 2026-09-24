/**
 * `GET`/`PUT`/`DELETE /playback/state` (API §4.9, DESIGN §3.12.3). The route handlers (`playback.routes.ts`) do
 * nothing but call these; the CAS decision itself lives in `playback.rules.ts` so it can be tested without HTTP or a
 * database.
 *
 * `PUT`/`DELETE` retry the read-decide-write cycle up to `MAX_CAS_ATTEMPTS` times (each its own short `db.write`,
 * docs/database.md §2.6): a lost race just means another write committed between our read and our CAS `UPDATE`, so
 * rules 1–3 are re-evaluated against the fresh row, not merely retried blindly. SSE `playback.updated` is published
 * only **after** the winning transaction commits (docs/database.md §2.4), and only when the change is significant.
 */
import type { PlaybackSummary } from "../../contract/live.ts";
import type { PlaybackPut, PlaybackPutResult, PlaybackState, PlaybackStateResponse } from "../../contract/playback.ts";
import type { AppContext } from "../../context.ts";
import type { RequestAuth } from "../../http/auth-guard.ts";
import { AppError } from "../../http/errors.ts";
import { newId } from "../../lib/ids.ts";
import { formatIso } from "../../lib/time.ts";
import {
  casInsertPlaybackState,
  casUpdatePlaybackState,
  deviceDisplayName,
  readPlaybackState,
} from "./playback.repository.ts";
import { decidePlaybackDelete, decidePlaybackPut } from "./playback.rules.ts";
import type { NewPlaybackRow, PutInput, StoredPlayback } from "./playback.rules.ts";
import { cleanTrackInput } from "./playback.tracks.ts";

export const MAX_CAS_ATTEMPTS = 3;
/** `Retry-After` once the CAS loses 3 races in a row (API §2.2 `server_busy`); short, like the driver's own 1..2 s. */
export const CAS_EXHAUSTED_RETRY_AFTER_SECONDS = 1;

function serverBusy(): never {
  throw new AppError("server_busy", { details: { retryAfterSeconds: CAS_EXHAUSTED_RETRY_AFTER_SECONDS } });
}

function handoffOf(row: Pick<StoredPlayback, "handoffDeviceId" | "handoffSessionId" | "handoffAt">) {
  return row.handoffDeviceId !== null && row.handoffSessionId !== null && row.handoffAt !== null
    ? { deviceId: row.handoffDeviceId, sessionId: row.handoffSessionId, at: formatIso(row.handoffAt) }
    : null;
}

function toApiState(row: StoredPlayback): PlaybackState {
  return {
    rev: row.rev,
    deviceId: row.deviceId,
    deviceName: row.deviceName,
    sessionId: row.sessionId,
    queueVersion: row.queueVersion,
    index: row.index,
    positionMs: row.positionMs,
    durationMs: row.durationMs,
    playing: row.playing,
    at: formatIso(row.stateAt),
    updatedAt: formatIso(row.updatedAt),
    queue: [...row.queue],
    handoffFrom: handoffOf(row),
  };
}

function toSummary(row: NewPlaybackRow): PlaybackSummary {
  return {
    rev: row.rev,
    deviceId: row.deviceId,
    deviceName: row.deviceName,
    sessionId: row.sessionId,
    queueVersion: row.queueVersion,
    index: row.index,
    queueLength: row.queue.length,
    track: row.queue[row.index] ?? null,
    positionMs: row.positionMs,
    durationMs: row.durationMs,
    playing: row.playing,
    at: formatIso(row.stateAt),
    updatedAt: formatIso(row.updatedAt),
    handoffFrom: handoffOf(row),
  };
}

/** `GET /playback/state` (API §4.9): `state: null` when there is none, or it was cleared by `DELETE`. */
export async function getPlaybackState(ctx: AppContext, userId: string): Promise<PlaybackStateResponse> {
  const row = await ctx.db.read((q) => readPlaybackState(q, userId));
  return {
    state: row && !row.cleared ? toApiState(row) : null,
    serverTime: formatIso(ctx.clock.now()),
  };
}

type PutAttemptOutcome =
  | Readonly<{ kind: "handed_off" | "newer_state"; current: StoredPlayback | null; nowMs: number }>
  | Readonly<{ kind: "queue_required" }>
  | Readonly<{ kind: "invalid_index" }>
  | Readonly<{ kind: "retry" }>
  | Readonly<{ kind: "applied"; row: NewPlaybackRow; significant: boolean; nowMs: number }>;

/** `PUT /playback/state` (API §4.9, DESIGN §3.12.3). */
export async function putPlaybackState(
  ctx: AppContext,
  auth: RequestAuth,
  body: PlaybackPut,
): Promise<PlaybackPutResult> {
  const queue = body.queue?.map((item) => cleanTrackInput(item));

  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const outcome = await ctx.db.write(async (q): Promise<PutAttemptOutcome> => {
      const stored = await readPlaybackState(q, auth.userId);
      const deviceName = await deviceDisplayName(q, auth.deviceId);
      const nowMs = ctx.clock.now();
      const input: PutInput = {
        deviceId: auth.deviceId,
        deviceName,
        sessionId: body.sessionId,
        queueVersion: body.queueVersion,
        atMs: body.at,
        index: body.index,
        positionMs: body.positionMs,
        durationMs: body.durationMs ?? null,
        playing: body.playing,
        ...(queue === undefined ? {} : { queue }),
        ...(body.handoffFrom === undefined ? {} : { handoffFrom: body.handoffFrom }),
      };
      const decision = decidePlaybackPut(stored, input, nowMs);

      if (decision.type === "handed_off" || decision.type === "newer_state") {
        return { kind: decision.type, current: stored, nowMs };
      }
      if (decision.type === "queue_required") return { kind: "queue_required" };
      if (decision.type === "invalid_index") return { kind: "invalid_index" };

      const applied = stored
        ? await casUpdatePlaybackState(q, auth.userId, stored.rev, decision.row, false)
        : await casInsertPlaybackState(q, auth.userId, decision.row, false);
      if (!applied) return { kind: "retry" };
      return { kind: "applied", row: decision.row, significant: decision.significant, nowMs };
    });

    switch (outcome.kind) {
      case "handed_off":
      case "newer_state":
        return {
          applied: false,
          rev: null,
          reason: outcome.kind,
          state: outcome.current && !outcome.current.cleared ? toApiState(outcome.current) : null,
          serverTime: formatIso(outcome.nowMs),
        };
      case "queue_required":
        throw new AppError("playback_queue_required");
      case "invalid_index":
        throw new AppError("invalid_request", {
          details: { issues: [{ path: "index", code: "too_big" }] },
          message: "index is outside the stored queue",
        });
      case "retry":
        continue;
      case "applied":
        if (outcome.significant) {
          ctx.live.publishCoalesced(
            auth.userId,
            "playback.updated",
            { rev: outcome.row.rev, cleared: false, state: toSummary(outcome.row) },
            { excludeDeviceId: auth.deviceId },
          );
        }
        return { applied: true, rev: outcome.row.rev, reason: null, state: null, serverTime: formatIso(outcome.nowMs) };
    }
  }
  serverBusy();
}

/** `DELETE /playback/state` (API §4.9): a tombstone, then `playback.updated{cleared:true}` (never coalesced away). */
export async function clearPlaybackState(ctx: AppContext, auth: RequestAuth): Promise<void> {
  const fallbackSessionId = newId();

  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const row = await ctx.db.write(async (q): Promise<NewPlaybackRow | null> => {
      const stored = await readPlaybackState(q, auth.userId);
      const nowMs = ctx.clock.now();
      const tombstone = decidePlaybackDelete(stored, { deviceId: auth.deviceId, fallbackSessionId }, nowMs);
      const applied = stored
        ? await casUpdatePlaybackState(q, auth.userId, stored.rev, tombstone, true)
        : await casInsertPlaybackState(q, auth.userId, tombstone, true);
      return applied ? tombstone : null;
    });
    if (row === null) continue;
    ctx.live.publishCoalesced(
      auth.userId,
      "playback.updated",
      { rev: row.rev, cleared: true, state: null },
      { excludeDeviceId: auth.deviceId },
    );
    return;
  }
  serverBusy();
}
