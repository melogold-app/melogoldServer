/**
 * Remote control of the other devices of the account (API §4.9 "Пульт", `features.remote`):
 *
 * - `GET /playback/devices` lists the other devices with their presence (`online`, `controllable`: the SSE streams of
 *   this process, `ctx.live.presence`) and, for the author of the current playback state, what it plays and its
 *   volume;
 * - `POST /playback/commands` checks the target (own device, not the caller → else `404 device_not_found`; an open
 *   stream → else `409 device_offline`; a stream with `remote=1` → else `409 remote_control_disabled`) and sends SSE
 *   `playback.command` to the target's `remote=1` streams only. Nothing is stored: the target executes the command
 *   and reports the result by its ordinary `PUT /playback/state`. A repeated `commandId` within
 *   {@link COMMAND_REPEAT_WINDOW_MS} answers the first result without delivering again.
 */
import type { AppContext } from "../../context.ts";
import type { RemoteCommand, RemoteCommandResult, RemoteDeviceList } from "../../contract/remote.ts";
import type { RequestAuth } from "../../http/auth-guard.ts";
import { AppError } from "../../http/errors.ts";
import { formatIso } from "../../lib/time.ts";
import { deviceDisplayName, listAccountDevices, readPlaybackState } from "./playback.repository.ts";
import { toSummary } from "./playback.service.ts";
import { cleanTrackInput } from "./playback.tracks.ts";

/** A repeated `commandId` within this window answers the first result, undelivered (API §4.9). */
export const COMMAND_REPEAT_WINDOW_MS = 60_000;

type RecentCommand = Readonly<{ result: RemoteCommandResult; at: number }>;

/** Recent commands per hub (one per app instance, so tests do not share them): `${userId}:${commandId}` → result. */
const recentByHub = new WeakMap<object, Map<string, RecentCommand>>();

function recentCommands(ctx: AppContext, now: number): Map<string, RecentCommand> {
  let recent = recentByHub.get(ctx.live);
  if (recent === undefined) {
    recent = new Map();
    recentByHub.set(ctx.live, recent);
  }
  for (const [key, entry] of recent) {
    if (now - entry.at >= COMMAND_REPEAT_WINDOW_MS) recent.delete(key);
  }
  return recent;
}

/** `GET /playback/devices` (API §4.9). */
export async function listRemoteDevices(ctx: AppContext, auth: RequestAuth): Promise<RemoteDeviceList> {
  const { devices, state } = await ctx.db.read(async (q) => ({
    devices: await listAccountDevices(q, auth.userId),
    state: await readPlaybackState(q, auth.userId),
  }));
  const presence = ctx.live.presence(auth.userId);
  const active = state && !state.cleared ? state : null;
  return {
    devices: devices
      .filter((device) => device.id !== auth.deviceId)
      .map((device) => {
        const author = active !== null && active.deviceId === device.id ? active : null;
        return {
          deviceId: device.id,
          name: device.name,
          platform: device.platform,
          online: presence.has(device.id),
          controllable: presence.get(device.id)?.remote ?? false,
          playing: author === null ? null : toSummary(author),
          volume: author?.volume ?? null,
        };
      }),
    serverTime: formatIso(ctx.clock.now()),
  };
}

/** `POST /playback/commands` (API §4.9). */
export async function sendRemoteCommand(
  ctx: AppContext,
  auth: RequestAuth,
  command: RemoteCommand,
): Promise<RemoteCommandResult> {
  const now = ctx.clock.now();
  const recent = recentCommands(ctx, now);
  const key = `${auth.userId}:${command.commandId}`;
  const repeated = recent.get(key);
  if (repeated !== undefined) return repeated.result;

  const { devices, fromDeviceName } = await ctx.db.read(async (q) => ({
    devices: await listAccountDevices(q, auth.userId),
    fromDeviceName: await deviceDisplayName(q, auth.deviceId),
  }));
  if (command.targetDeviceId === auth.deviceId || !devices.some((device) => device.id === command.targetDeviceId)) {
    throw new AppError("device_not_found");
  }
  const presence = ctx.live.presence(auth.userId).get(command.targetDeviceId);
  if (presence === undefined) throw new AppError("device_offline");
  if (!presence.remote) throw new AppError("remote_control_disabled");

  const delivered =
    ctx.live.publishToRemote(auth.userId, command.targetDeviceId, "playback.command", {
      commandId: command.commandId,
      fromDeviceId: auth.deviceId,
      fromDeviceName,
      action: command.action,
      // play_queue: с какой секунды начать трек `index` — перенос воспроизведения «как AirPlay» (задание 0005).
      positionMs: command.action === "seek" || command.action === "play_queue" ? (command.positionMs ?? null) : null,
      volume: command.action === "volume" ? (command.volume ?? null) : null,
      queue: command.action === "play_queue" ? (command.queue ?? []).map((item) => cleanTrackInput(item)) : null,
      index: command.action === "play_queue" ? (command.index ?? null) : null,
    }) > 0;
  const result: RemoteCommandResult = { delivered };
  recent.set(key, { result, at: now });
  return result;
}
