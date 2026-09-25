/**
 * The catalog of live events (API §6). Frozen after M0 (PLAN, general rules item 2): a new event type starts with an
 * edit of `docs/API.md`, then `src/contract/live.ts`, then this table.
 *
 * | type                  | audience                               | coalescing                   |
 * | --------------------- | -------------------------------------- | ---------------------------- |
 * | `system.connected`    | the stream being opened                | —                            |
 * | `sync.changed`        | every device of the user but the author | 2 s (API §6)                 |
 * | `playback.updated`    | every device of the user but the author | 1 s, trailing (DESIGN §3.12.4) |
 * | `devices.updated`     | every device of the user               | —                            |
 * | `session.invalidated` | one device (addressed)                 | —                            |
 * | `account.updated`     | every device of the user but the author | —                            |
 * | `link.updated`        | the approving device (addressed)       | —                            |
 * | `lyrics.changed`      | every device of the user but the author | 2 s (API §6)                 |
 *
 * Wire format (API §6): the first frame of a stream is `retry: 5000`, every event is
 * `id: <uuid>\ndata: <LiveEvent JSON>\n\n` **without** an `event:` line, heartbeats are comments. Events are published
 * only after commit; there is no replay (`Last-Event-ID` is ignored).
 */
import type { z } from "zod";
import { LIVE_EVENT_PAYLOADS, LIVE_EVENT_TYPES } from "../../contract/live.ts";
import type { LiveEvent, LiveEventType, LivePayload } from "../../contract/live.ts";
import { newId } from "../../lib/ids.ts";
import { formatIso } from "../../lib/time.ts";

export { LIVE_EVENT_TYPES };
export type { LiveEvent, LiveEventType, LivePayload };

/**
 * Who receives an event:
 * - `stream`: only the stream it is written to (the route writes it directly);
 * - `user`: every stream of the user;
 * - `others`: every stream of the user except the author's device (`exceptDeviceId` / `excludeDeviceId`);
 * - `device`: the streams of one device (`onlyDeviceId`).
 */
export type LiveAudience = "stream" | "user" | "others" | "device";

export type LiveEventSpec = Readonly<{
  payload: z.ZodType;
  audience: LiveAudience;
  /** Window of `publishCoalesced` for this type (ms), or `null` when the type is never coalesced. */
  coalesceMs: number | null;
}>;

/** API §6 `sync.changed`: "склейка 2 с". */
export const SYNC_CHANGED_COALESCE_MS = 2000;
/** DESIGN §3.12.4: `playback.updated` at most once per second per user, trailing. */
export const PLAYBACK_UPDATED_COALESCE_MS = 1000;

export const LIVE_EVENTS: Readonly<Record<LiveEventType, LiveEventSpec>> = Object.freeze({
  "system.connected": { payload: LIVE_EVENT_PAYLOADS["system.connected"], audience: "stream", coalesceMs: null },
  "sync.changed": {
    payload: LIVE_EVENT_PAYLOADS["sync.changed"],
    audience: "others",
    coalesceMs: SYNC_CHANGED_COALESCE_MS,
  },
  "playback.updated": {
    payload: LIVE_EVENT_PAYLOADS["playback.updated"],
    audience: "others",
    coalesceMs: PLAYBACK_UPDATED_COALESCE_MS,
  },
  "devices.updated": { payload: LIVE_EVENT_PAYLOADS["devices.updated"], audience: "user", coalesceMs: null },
  "session.invalidated": {
    payload: LIVE_EVENT_PAYLOADS["session.invalidated"],
    audience: "device",
    coalesceMs: null,
  },
  "account.updated": { payload: LIVE_EVENT_PAYLOADS["account.updated"], audience: "others", coalesceMs: null },
  "link.updated": { payload: LIVE_EVENT_PAYLOADS["link.updated"], audience: "device", coalesceMs: null },
  "lyrics.changed": {
    payload: LIVE_EVENT_PAYLOADS["lyrics.changed"],
    audience: "others",
    coalesceMs: SYNC_CHANGED_COALESCE_MS,
  },
});

export function isLiveEventType(value: unknown): value is LiveEventType {
  return typeof value === "string" && (LIVE_EVENT_TYPES as readonly string[]).includes(value);
}

export class LivePayloadError extends Error {
  readonly type: LiveEventType;

  constructor(type: LiveEventType, cause: unknown) {
    super(`payload of ${type} does not match its schema (API §6)`, { cause });
    this.name = "LivePayloadError";
    this.type = type;
  }
}

/**
 * The `LiveEvent` envelope `{id, type, at, payload}` (API §6). The payload is checked against the schema of its type.
 * @throws LivePayloadError when the payload does not match.
 */
export function buildLiveEvent<T extends LiveEventType>(
  type: T,
  payload: LivePayload<T>,
  now: number,
  id: string = newId(),
): LiveEvent {
  const parsed = LIVE_EVENTS[type].payload.safeParse(payload);
  if (!parsed.success) throw new LivePayloadError(type, parsed.error);
  return Object.freeze({ id, type, at: formatIso(now), payload: parsed.data as Record<string, unknown> });
}

/** API §6: the reconnect delay the first frame announces. */
export const SSE_RETRY_MS = 5000;

/** The first frame of every stream: `retry: 5000`. */
export function sseRetryFrame(retryMs: number = SSE_RETRY_MS): string {
  return `retry: ${retryMs}\n\n`;
}

/** One event: `id: <uuid>`, `data: <LiveEvent JSON>`, no `event:` line (API §6). */
export function sseEventFrame(event: LiveEvent): string {
  return `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** A heartbeat comment: `: heartbeat <epoch ms>`. */
export function sseHeartbeatFrame(now: number): string {
  return `: heartbeat ${now}\n\n`;
}
