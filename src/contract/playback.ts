/**
 * API §4.9: "continue on another device" (`GET/PUT/DELETE /playback/state`; rules DESIGN §3.12.3).
 *
 * `PlaybackPut.queue` items are {@link TrackInput}: a bad `videoId` or an `index` outside the queue answers
 * `400 invalid_request` (dropping an item would shift `index`); the metadata is cleaned leniently by the service.
 */
import { z } from "zod";
import {
  enumOut,
  int,
  Int32Out,
  IntOut,
  Iso,
  IsoOut,
  optional,
  textOut,
  TrackDto,
  TrackInput,
  Uuid,
  UuidOut,
} from "./common.ts";
import { INT32_MAX, PLAYBACK_LIMITS, STRING_LIMITS } from "./limits.ts";

/** `PlaybackPutResult.reason` when `applied` is false. */
export const PLAYBACK_REJECT_REASON_VALUES = ["newer_state", "handed_off"] as const;
export type PlaybackRejectReason = (typeof PLAYBACK_REJECT_REASON_VALUES)[number];

export const PlaybackHandoff = z
  .object({ deviceId: UuidOut, sessionId: UuidOut, at: IsoOut })
  .meta({ id: "PlaybackHandoff", description: 'The state this one took over from ("listen here").' });

export const PlaybackHandoffInput = z.object({ deviceId: Uuid, sessionId: Uuid }).meta({ id: "PlaybackHandoffInput" });

export const PlaybackState = z
  .object({
    rev: IntOut.meta({ description: "max(prev.rev + 1, serverNowMs); never decreases, also after DELETE." }),
    deviceId: UuidOut,
    deviceName: textOut(STRING_LIMITS.deviceName).nullable(),
    sessionId: UuidOut,
    queueVersion: Int32Out,
    index: IntOut,
    positionMs: IntOut,
    durationMs: IntOut.nullable(),
    playing: z.boolean(),
    at: IsoOut.meta({ description: "effAt: min(client at, server now)." }),
    updatedAt: IsoOut,
    queue: z.array(TrackDto).meta({ minItems: 1, maxItems: PLAYBACK_LIMITS.queueMax }),
    handoffFrom: PlaybackHandoff.nullable(),
  })
  .meta({ id: "PlaybackState" });

export const PlaybackStateResponse = z
  .object({
    state: PlaybackState.nullable().meta({ description: "`null`: no state, or cleared by DELETE." }),
    serverTime: IsoOut,
  })
  .meta({ id: "PlaybackStateResponse" });

export const PlaybackPut = z
  .object({
    sessionId: Uuid,
    queueVersion: int(0, INT32_MAX),
    at: Iso,
    index: int(0, PLAYBACK_LIMITS.queueMax - 1).meta({ description: "0..len−1 of the queue." }),
    positionMs: int(0),
    durationMs: optional(int(0)),
    playing: z.boolean(),
    queue: optional(
      z
        .array(TrackInput)
        .min(1)
        .max(PLAYBACK_LIMITS.queueMax)
        .meta({ description: "Only when (sessionId, queueVersion) changed since the last successful PUT." }),
    ),
    handoffFrom: optional(PlaybackHandoffInput).meta({ description: 'Only for "listen here".' }),
  })
  .superRefine((put, ctx) => {
    if (put.queue !== undefined && put.index >= put.queue.length) {
      ctx.addIssue({
        code: "too_big",
        origin: "number",
        maximum: put.queue.length - 1,
        inclusive: true,
        input: put.index,
        path: ["index"],
        message: "index is outside the queue",
      });
    }
  })
  .meta({ id: "PlaybackPut" });

export const PlaybackPutResult = z
  .object({
    applied: z.boolean(),
    rev: IntOut.nullable(),
    reason: enumOut(PLAYBACK_REJECT_REASON_VALUES, "Only when not applied.").nullable(),
    state: PlaybackState.nullable().meta({ description: "When not applied: the current state, with queue." }),
    serverTime: IsoOut,
  })
  .meta({ id: "PlaybackPutResult" });

export type PlaybackHandoff = z.output<typeof PlaybackHandoff>;
export type PlaybackHandoffInput = z.output<typeof PlaybackHandoffInput>;
export type PlaybackState = z.output<typeof PlaybackState>;
export type PlaybackStateResponse = z.output<typeof PlaybackStateResponse>;
export type PlaybackPut = z.output<typeof PlaybackPut>;
export type PlaybackPutResult = z.output<typeof PlaybackPutResult>;
