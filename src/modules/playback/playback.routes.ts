/**
 * Routes of the `playback` module (API §4.9, T2.4): "continue on another device". All three require
 * `X-Sync-Protocol`.
 *
 * M0: development stubs with their complete schemas (PLAN step 0.8); every handler answers `501 not_implemented`.
 * T2.4 declares `ctx.features.declare("playback", FEATURE_V1)`.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { AppContext } from "../../context.ts";
import { PlaybackPut, PlaybackPutResult, PlaybackStateResponse } from "../../contract/playback.ts";
import { notImplemented, operation } from "../../http/operation.ts";

export function registerPlaybackRoutes(app: FastifyInstance, _ctx: AppContext): void {
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
    notImplemented,
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
    notImplemented,
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
    notImplemented,
  );
}
