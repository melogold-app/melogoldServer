/**
 * API §4.9 "Пульт": remote control of the other devices of the account (`GET /playback/devices`,
 * `POST /playback/commands`, SSE `playback.command` of §6). Kept apart from `playback.ts`, which `live.ts` imports:
 * `RemoteDevice` needs `PlaybackSummary` of `live.ts`.
 */
import { z } from "zod";
import { int, IntOut, IsoOut, optional, textOut, TrackInput, Uuid, UuidOut } from "./common.ts";
import { PLAYBACK_LIMITS, STRING_LIMITS, VOLUME_MAX } from "./limits.ts";
import { PlaybackSummary, REMOTE_ACTION_VALUES } from "./live.ts";

export { REMOTE_ACTION_VALUES };
export type { RemoteAction } from "./live.ts";

export const RemoteDevice = z
  .object({
    deviceId: UuidOut,
    name: textOut(STRING_LIMITS.deviceName),
    platform: z.string(),
    online: z.boolean().meta({ description: "The device has an SSE stream open right now." }),
    controllable: z.boolean().meta({ description: "At least one of its streams was opened with remote=1." }),
    playing: PlaybackSummary.nullable().meta({ description: "When this device is the author of the current state." }),
    volume: IntOut.nullable().meta({ description: "0..100, as the device last reported it." }),
  })
  .meta({ id: "RemoteDevice" });

export const RemoteDeviceList = z
  .object({
    devices: z.array(RemoteDevice).meta({ description: "The other devices of the account, by name." }),
    serverTime: IsoOut,
  })
  .meta({ id: "RemoteDeviceList" });

export const RemoteCommand = z
  .object({
    commandId: Uuid.meta({ description: "Made by the client; a repeat within 60 s answers the same, not delivered." }),
    targetDeviceId: Uuid,
    action: z.enum(REMOTE_ACTION_VALUES),
    positionMs: optional(int(0)).meta({ description: "seek; play_queue: start position in the track at index." }),
    volume: optional(int(0, VOLUME_MAX)).meta({ description: "volume: 0..100." }),
    queue: optional(z.array(TrackInput).min(1).max(PLAYBACK_LIMITS.queueMax)).meta({ description: "play_queue." }),
    index: optional(int(0, PLAYBACK_LIMITS.queueMax - 1)).meta({ description: "play_queue: 0..len−1." }),
  })
  .superRefine((command, ctx) => {
    const missing = (path: string) =>
      ctx.addIssue({ code: "custom", path: [path], message: `${path} is required by ${command.action}` });
    if (command.action === "seek" && command.positionMs === undefined) missing("positionMs");
    if (command.action === "volume" && command.volume === undefined) missing("volume");
    if (command.action === "play_queue") {
      if (command.queue === undefined) missing("queue");
      if (command.index === undefined) missing("index");
      if (command.queue !== undefined && command.index !== undefined && command.index >= command.queue.length) {
        ctx.addIssue({
          code: "too_big",
          origin: "number",
          maximum: command.queue.length - 1,
          inclusive: true,
          input: command.index,
          path: ["index"],
          message: "index is outside the queue",
        });
      }
    }
  })
  .meta({ id: "RemoteCommand" });

export const RemoteCommandResult = z
  .object({ delivered: z.boolean().meta({ description: "false: the target left at this very moment." }) })
  .meta({ id: "RemoteCommandResult" });

export type RemoteDevice = z.output<typeof RemoteDevice>;
export type RemoteDeviceList = z.output<typeof RemoteDeviceList>;
export type RemoteCommand = z.output<typeof RemoteCommand>;
export type RemoteCommandResult = z.output<typeof RemoteCommandResult>;
