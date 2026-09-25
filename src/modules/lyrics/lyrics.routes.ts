/**
 * Routes of the `lyrics` module (API §4.10): the user's lyrics of a track, the shared version and the changes feed of
 * the user's devices. Declares `ctx.features.declare("lyrics", FEATURE_V1)` (API §4.2).
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { AppContext } from "../../context.ts";
import {
  LyricsChangesRequest,
  LyricsPut,
  LyricsResponse,
  MyLyrics,
  MyLyricsPage,
  VideoIdParams,
} from "../../contract/lyrics.ts";
import { requireAuth } from "../../http/auth-guard.ts";
import { operation } from "../../http/operation.ts";
import { FEATURE_V1 } from "../server/features.ts";
import { deleteLyrics, getLyrics, listMyLyricsChanges, putLyrics } from "./lyrics.service.ts";

export function registerLyricsRoutes(app: FastifyInstance, ctx: AppContext): void {
  ctx.features.declare("lyrics", FEATURE_V1);
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.get(
    "/lyrics/:videoId",
    {
      schema: operation("GET", "/lyrics/:videoId", {
        operationId: "getLyrics",
        tag: "lyrics",
        summary: "The caller's lyrics of a track and the shared version",
        description: "`shared` prefers synced lyrics, then the most recent; its author is not disclosed (API §4.10).",
        params: VideoIdParams,
        status: 200,
        response: LyricsResponse,
      }),
    },
    (request) => getLyrics(ctx, requireAuth(request).userId, request.params.videoId),
  );

  routes.put(
    "/lyrics/:videoId",
    {
      schema: operation("PUT", "/lyrics/:videoId", {
        operationId: "putLyrics",
        tag: "lyrics",
        summary: "Save the caller's lyrics of a track",
        description:
          "Creates or replaces the version; unchanged content keeps `rev` and sends no event. Otherwise `rev` grows " +
          "and `lyrics.changed` goes to the other devices (API §4.10).",
        params: VideoIdParams,
        body: LyricsPut,
        status: 200,
        response: MyLyrics,
      }),
    },
    (request) => putLyrics(ctx, requireAuth(request), request.params.videoId, request.body),
  );

  routes.delete(
    "/lyrics/:videoId",
    {
      schema: operation("DELETE", "/lyrics/:videoId", {
        operationId: "deleteLyrics",
        tag: "lyrics",
        summary: "Delete the caller's lyrics of a track",
        description: "Writes a tombstone, then `lyrics.changed`; nothing when there is no live version (API §4.10).",
        params: VideoIdParams,
        status: 204,
      }),
    },
    async (request, reply) => {
      await deleteLyrics(ctx, requireAuth(request), request.params.videoId);
      return reply.code(204).send();
    },
  );

  routes.post(
    "/auth/me/lyrics/changes",
    {
      schema: operation("POST", "/auth/me/lyrics/changes", {
        operationId: "listMyLyricsChanges",
        tag: "lyrics",
        summary: "The caller's lyrics changed after a revision",
        description: "Ascending `rev`; the first load (`after: 0`) leaves tombstones out (API §4.10).",
        body: LyricsChangesRequest,
        status: 200,
        response: MyLyricsPage,
      }),
    },
    (request) => listMyLyricsChanges(ctx, requireAuth(request).userId, request.body),
  );
}
