/**
 * API §6: SSE `GET /auth/me/events`. Every frame is `id: <uuid>\ndata: <LiveEvent JSON>\n\n` without `event:`; the
 * payload schemas and `PlaybackSummary` are registered components (API §6: CI checks that every `*Payload` is).
 *
 * `AccountUpdatedPayload.byDevice` is written inline in API.md; it is the named component `DeviceRef` here (API §1.1).
 * The event catalog (type → payload, who receives it) is `src/modules/live/live.events.ts`.
 */
import { z } from "zod";
import { CursorOut, enumOut, Int32Out, IntOut, IsoOut, TrackDto, UuidOut, VideoIdOut } from "./common.ts";
import { PlaybackHandoff } from "./playback.ts";

export const LIVE_EVENT_TYPES = [
  "system.connected",
  "sync.changed",
  "playback.updated",
  "devices.updated",
  "session.invalidated",
  "account.updated",
  "link.updated",
  "lyrics.changed",
  "playback.command",
] as const;
export type LiveEventType = (typeof LIVE_EVENT_TYPES)[number];

export const DEVICES_UPDATED_REASON_VALUES = [
  "device_added",
  "device_removed",
  "device_renamed",
  "device_signed_out",
] as const;
export type DevicesUpdatedReason = (typeof DEVICES_UPDATED_REASON_VALUES)[number];

export const SESSION_INVALIDATED_REASON_VALUES = [
  "device_revoked",
  "password_changed",
  "recovery_reset",
  "token_reuse",
  "account_deleted",
] as const;
export type SessionInvalidatedReason = (typeof SESSION_INVALIDATED_REASON_VALUES)[number];

export const ACCOUNT_UPDATED_REASON_VALUES = [
  "password_changed",
  "password_changed_without_old",
  "recovery_code_rotated",
] as const;
export type AccountUpdatedReason = (typeof ACCOUNT_UPDATED_REASON_VALUES)[number];

export const LINK_UPDATED_STATUS_VALUES = ["claimed", "cancelled", "completed"] as const;
export type LinkUpdatedStatus = (typeof LINK_UPDATED_STATUS_VALUES)[number];

/** API §6: `GET /auth/me/events?remote=1` — the device can be controlled by the other devices (API §4.9). */
export const LiveEventsQuery = z.object({
  remote: z.enum(["0", "1"]).optional().meta({ description: "1: receive playback.command (remote control)." }),
});
export type LiveEventsQuery = z.output<typeof LiveEventsQuery>;

export const LiveEvent = z
  .object({
    id: UuidOut,
    type: enumOut(LIVE_EVENT_TYPES),
    at: IsoOut,
    payload: z
      .looseObject({})
      .nullable()
      .meta({ description: "The `*Payload` of the type (API §6); clients ignore unknown types." }),
  })
  .meta({ id: "LiveEvent", description: "One SSE frame: `id: <uuid>` + `data: <LiveEvent JSON>`, no `event:` line." });

export const SystemConnectedPayload = z
  .object({ heartbeatMs: IntOut, retryMs: IntOut })
  .meta({ id: "SystemConnectedPayload", description: "system.connected: to this stream, on open." });

export const SyncChangedPayload = z
  .object({ cursor: CursorOut })
  .meta({ id: "SyncChangedPayload", description: "sync.changed: every device except the author; coalesced for 2 s." });

export const PlaybackSummary = z
  .object({
    rev: IntOut,
    deviceId: UuidOut,
    deviceName: z.string().nullable(),
    sessionId: UuidOut,
    queueVersion: Int32Out,
    index: IntOut,
    queueLength: IntOut,
    track: TrackDto.nullable(),
    positionMs: IntOut,
    durationMs: IntOut.nullable(),
    playing: z.boolean(),
    at: IsoOut,
    updatedAt: IsoOut,
    handoffFrom: PlaybackHandoff.nullable(),
    volume: IntOut.nullable(),
  })
  .meta({ id: "PlaybackSummary", description: "The playback state without the queue (the current track only)." });

export const PlaybackUpdatedPayload = z
  .object({
    rev: IntOut,
    cleared: z.boolean(),
    state: PlaybackSummary.nullable(),
  })
  .meta({
    id: "PlaybackUpdatedPayload",
    description: "playback.updated: every device except the author; significant changes or DELETE, at most 1/s.",
  });

export const DevicesUpdatedPayload = z
  .object({
    reason: enumOut(DEVICES_UPDATED_REASON_VALUES),
    deviceId: UuidOut.nullable(),
  })
  .meta({ id: "DevicesUpdatedPayload", description: "devices.updated: every device of the user." });

export const SessionInvalidatedPayload = z
  .object({
    reason: enumOut(SESSION_INVALIDATED_REASON_VALUES),
    forceRelogin: z.boolean().meta({ description: "Always true." }),
  })
  .meta({ id: "SessionInvalidatedPayload", description: "session.invalidated: addressed, before the streams close." });

export const DeviceRef = z.object({ id: UuidOut, name: z.string() }).meta({ id: "DeviceRef" });

export const AccountUpdatedPayload = z
  .object({
    reason: enumOut(ACCOUNT_UPDATED_REASON_VALUES),
    byDevice: DeviceRef,
  })
  .meta({ id: "AccountUpdatedPayload", description: "account.updated: every device except the author." });

export const LinkUpdatedPayload = z
  .object({
    linkId: UuidOut,
    status: enumOut(LINK_UPDATED_STATUS_VALUES),
  })
  .meta({ id: "LinkUpdatedPayload", description: "link.updated: the approving device, on the other side's action." });

export const LyricsChangedPayload = z.object({ videoId: VideoIdOut, rev: IntOut }).meta({
  id: "LyricsChangedPayload",
  description: "lyrics.changed: every device except the author, after PUT/DELETE /lyrics/{videoId}; coalesced for 2 s.",
});

/** API §4.9 `RemoteCommand.action`. */
export const REMOTE_ACTION_VALUES = [
  "play",
  "pause",
  "toggle",
  "next",
  "previous",
  "seek",
  "volume",
  "play_queue",
  "stop",
] as const;
export type RemoteAction = (typeof REMOTE_ACTION_VALUES)[number];

export const PlaybackCommandPayload = z
  .object({
    commandId: UuidOut,
    fromDeviceId: UuidOut,
    fromDeviceName: z.string().nullable(),
    action: enumOut(REMOTE_ACTION_VALUES),
    positionMs: IntOut.nullable(),
    volume: IntOut.nullable(),
    queue: z.array(TrackDto).nullable(),
    index: IntOut.nullable(),
  })
  .meta({
    id: "PlaybackCommandPayload",
    description:
      "playback.command: the target device only, streams opened with remote=1 (API §4.9); fields the action has not are null.",
  });

/** API §6 table: the payload schema of each event type. */
export const LIVE_EVENT_PAYLOADS = Object.freeze({
  "system.connected": SystemConnectedPayload,
  "sync.changed": SyncChangedPayload,
  "playback.updated": PlaybackUpdatedPayload,
  "devices.updated": DevicesUpdatedPayload,
  "session.invalidated": SessionInvalidatedPayload,
  "account.updated": AccountUpdatedPayload,
  "link.updated": LinkUpdatedPayload,
  "lyrics.changed": LyricsChangedPayload,
  "playback.command": PlaybackCommandPayload,
} satisfies Record<LiveEventType, z.ZodType>);

/** The payload type of an event type. */
export type LivePayload<T extends LiveEventType> = z.output<(typeof LIVE_EVENT_PAYLOADS)[T]>;

export type LiveEvent = z.output<typeof LiveEvent>;
export type PlaybackSummary = z.output<typeof PlaybackSummary>;
