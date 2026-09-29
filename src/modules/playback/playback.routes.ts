/**
 * Routes of the `playback` module (API §4.9, T2.4): "continue on another device". All three require
 * `X-Sync-Protocol`. Declares `ctx.features.declare("playback", FEATURE_V1)` (API §4.2).
 *
 * The rule engine is `playback.rules.ts` (pure) and `playback.service.ts` (I/O, CAS, SSE); routes only wire the
 * request to the service and pick the HTTP status.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { AppContext } from "../../context.ts";
import { PlaybackPut, PlaybackPutResult, PlaybackStateResponse } from "../../contract/playback.ts";
import { RemoteCommand, RemoteCommandResult, RemoteDeviceList } from "../../contract/remote.ts";
import { requireAuth } from "../../http/auth-guard.ts";
import { operation } from "../../http/operation.ts";
import { FEATURE_V1 } from "../server/features.ts";
import { clearPlaybackState, getPlaybackState, putPlaybackState } from "./playback.service.ts";
import { listRemoteDevices, sendRemoteCommand } from "./remote.service.ts";

export function registerPlaybackRoutes(app: FastifyInstance, ctx: AppContext): void {
  ctx.features.declare("playback", FEATURE_V1);
  ctx.features.declare("remote", FEATURE_V1);
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.get(
    "/playback/state",
    {
      schema: operation("GET", "/playback/state", {
        operationId: "getPlaybackState",
        tag: "playback",
        summary: "The current playback state of the account",
        description: "`state: null` when there is none or it was cleared (API §4.9).",
        status: 200,
        response: PlaybackStateResponse,
      }),
    },
    (request) => getPlaybackState(ctx, requireAuth(request).userId),
  );

  routes.put(
    "/playback/state",
    {
      schema: operation("PUT", "/playback/state", {
        operationId: "putPlaybackState",
        tag: "playback",
        summary: "Publish the playback state of this device",
        description:
          "Rules in order: handed_off, newer_state, 409 playback_queue_required, CAS up to 3 attempts then 503 " +
          "server_busy (API §4.9, DESIGN §3.12.3).",
        body: PlaybackPut,
        status: 200,
        response: PlaybackPutResult,
        errors: ["playback_queue_required"],
      }),
    },
    (request) => putPlaybackState(ctx, requireAuth(request), request.body),
  );

  routes.delete(
    "/playback/state",
    {
      schema: operation("DELETE", "/playback/state", {
        operationId: "clearPlaybackState",
        tag: "playback",
        summary: "Forget the current playback",
        description: "Writes a tombstone, then playback.updated{cleared: true} to the other devices (API §4.9).",
        status: 204,
      }),
    },
    async (request, reply) => {
      await clearPlaybackState(ctx, requireAuth(request));
      return reply.code(204).send();
    },
  );

  routes.get(
    "/playback/devices",
    {
      schema: operation("GET", "/playback/devices", {
        operationId: "listRemoteDevices",
        tag: "playback",
        summary: "The other devices of the account, for the remote control",
        description:
          "online and controllable come from the open SSE streams (remote=1); playing and volume from the current " +
          "playback state when the device is its author (API §4.9).",
        status: 200,
        response: RemoteDeviceList,
      }),
    },
    (request) => listRemoteDevices(ctx, requireAuth(request)),
  );

  routes.post(
    "/playback/commands",
    {
      schema: operation("POST", "/playback/commands", {
        operationId: "sendRemoteCommand",
        tag: "playback",
        summary: "Send a playback command to another device",
        description:
          "Delivered as SSE playback.command to the target's remote=1 streams, never stored; the target reports the " +
          "result by PUT /playback/state. A repeated commandId within 60 s answers the same (API §4.9).",
        body: RemoteCommand,
        status: 202,
        response: RemoteCommandResult,
        errors: ["device_not_found", "device_offline", "remote_control_disabled"],
      }),
    },
    async (request, reply) => {
      const result = await sendRemoteCommand(ctx, requireAuth(request), request.body);
      return reply.code(202).send(result);
    },
  );
}
