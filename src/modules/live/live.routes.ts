/**
 * Route of the `live` module (API §6, T1.5): `GET /auth/me/events`, the SSE stream of `LiveEvent` frames.
 *
 * M0: a development stub with its complete schema (PLAN step 0.8): the guard runs, then `501 not_implemented` before
 * anything is hijacked. T1.5 registers the stream in `ctx.live` (`live.hub.ts`) and writes the frames of
 * `live.events.ts`.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { AppContext } from "../../context.ts";
import { LiveEvent } from "../../contract/live.ts";
import { EVENT_STREAM, notImplemented, operation } from "../../http/operation.ts";

export function registerLiveRoutes(app: FastifyInstance, _ctx: AppContext): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.get(
    "/auth/me/events",
    {
      schema: operation("GET", "/auth/me/events", {
        operationId: "streamEvents",
        tag: "live",
        summary: "Live events (server-sent events)",
        description:
          "`text/event-stream`: first `retry: 5000`, then system.connected; each event is `id: <uuid>` + " +
          "`data: <LiveEvent JSON>` without an `event:` line; heartbeats are comments. No replay (Last-Event-ID is " +
          "ignored). The server closes the stream at the token's `exp`, after session.invalidated, when auth_version " +
          "grows and on shutdown; at most 4 streams per device and 64 per user (API §6).",
        status: 200,
        response: LiveEvent,
        contentType: EVENT_STREAM,
      }),
    },
    notImplemented,
  );
}
