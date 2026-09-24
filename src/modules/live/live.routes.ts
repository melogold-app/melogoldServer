/**
 * Route of the `live` module (API §6, DESIGN §4.7, PLAN T1.5): `GET /auth/me/events`, the SSE stream of `LiveEvent`
 * frames.
 *
 * The Bearer guard (API §1.7) and the limit of 30 openings per minute per user (API §1.10) run before the handler, so
 * a refused stream is an ordinary JSON error. Then the handler takes over the connection (`reply.hijack()`):
 *
 * 1. headers: `200`, `text/event-stream; charset=utf-8`, `Cache-Control: no-store, no-transform`,
 *    `X-Accel-Buffering: no`, plus the ones the hooks already set (`X-Request-Id`, security headers, CORS). The
 *    compression and `no-store` hooks run on `onSend`, which a hijacked reply skips: SSE is never compressed (API §1.2);
 * 2. the first frame `retry: 5000`, then the stream joins the hub (`ctx.live.register`: beyond 4 streams of the device
 *    or 64 of the user the oldest one is closed), then `system.connected {heartbeatMs, retryMs}` to this stream only;
 * 3. every event is `id: <uuid>\ndata: <LiveEvent JSON>\n\n` without `event:`; every `SSE_HEARTBEAT_SECONDS` the
 *    heartbeat loop (`revalidate.ts`) writes `: heartbeat <ms>` and rechecks the devices in the database;
 * 4. the stream closes at the `exp` of its access token (a timer, with the heartbeat as a safety net), when the hub
 *    closes it (session invalidated, device removed, `auth_version` grown, evicted, shutdown: `preClose` in `app.ts`
 *    calls `closeAll`), when a write fails or the client stops reading (more than {@link SSE_MAX_BUFFERED_BYTES}
 *    pending), and when the client goes away. `Last-Event-ID` is ignored: there is no replay.
 *
 * `HEAD` answers the headers and ends without opening a stream.
 */
import type { OutgoingHttpHeaders } from "node:http";
import type { Socket } from "node:net";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { AppContext } from "../../context.ts";
import { LiveEvent } from "../../contract/live.ts";
import { requireAuth } from "../../http/auth-guard.ts";
import type { RequestAuth } from "../../http/auth-guard.ts";
import { AppError } from "../../http/errors.ts";
import { EVENT_STREAM, operation } from "../../http/operation.ts";
import { SECOND_MS } from "../../lib/clock.ts";
import type { LiveCloseReason, LiveRegistration, LiveStreamHandle } from "./live.hub.ts";
import { SSE_RETRY_MS, buildLiveEvent, sseEventFrame, sseHeartbeatFrame, sseRetryFrame } from "./live.events.ts";
import { LiveHeartbeat, revalidateStreams } from "./revalidate.ts";

/** API §6 transport headers. */
export const SSE_CONTENT_TYPE = "text/event-stream; charset=utf-8";
export const SSE_CACHE_CONTROL = "no-store, no-transform";

/**
 * A client that stops reading is dropped once this much output waits for it (a few hundred events), so a stuck
 * connection cannot hold unbounded memory.
 */
export const SSE_MAX_BUFFERED_BYTES = 512 * 1024;

/** The longest delay `setTimeout` accepts; a later `exp` is caught by the heartbeat. */
const MAX_TIMER_MS = 2_147_483_647;

class StreamClosedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamClosedError";
  }
}

type StreamDeps = Readonly<{ ctx: AppContext; heartbeat: LiveHeartbeat; heartbeatMs: number }>;

/** The client socket; `app.inject` gives a mock without these members, so each one is optional. */
type ClientSocket = Partial<Pick<Socket, "destroyed" | "setKeepAlive" | "end">>;

/** The headers the hooks set on the reply (hijacking skips `onSend`), then the transport headers of API §6. */
function streamHeaders(reply: FastifyReply): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (value !== undefined) headers[name] = value;
  }
  headers["content-type"] = SSE_CONTENT_TYPE;
  headers["cache-control"] = SSE_CACHE_CONTROL;
  headers["x-accel-buffering"] = "no";
  return headers;
}

/** Hijacks the reply and runs the stream until it closes (steps 1–4 of the module comment). */
function openStream(deps: StreamDeps, request: FastifyRequest, reply: FastifyReply, auth: RequestAuth): void {
  const { ctx } = deps;
  const hub = ctx.live;
  const timers = hub.timers;
  const raw = reply.raw;
  const socket = request.raw.socket as ClientSocket | null;
  reply.hijack();

  if (raw.destroyed || socket?.destroyed === true) return; // the client left while the guard ran
  raw.writeHead(200, streamHeaders(reply));
  if (request.method === "HEAD") {
    raw.end();
    return;
  }
  socket?.setKeepAlive?.(true);

  let registration: LiveRegistration | null = null;
  let expiry: unknown = null;
  let done = false;

  /** Forgets the stream and its timer; idempotent. */
  const finish = (): void => {
    if (done) return;
    done = true;
    if (expiry !== null) timers.clearTimeout(expiry);
    registration?.unregister();
  };

  const write = (frame: string): void => {
    if (raw.writableEnded || raw.destroyed) throw new StreamClosedError("the connection is closed");
    raw.write(frame);
    if (raw.writableLength > SSE_MAX_BUFFERED_BYTES) throw new StreamClosedError("the client does not read");
  };

  const end = (reason: LiveCloseReason): void => {
    finish();
    request.log.debug({ reason }, "live stream closed");
    if (reason === "broken") {
      raw.destroy();
      return;
    }
    if (!raw.writableEnded) raw.end();
    // On shutdown the connection goes too, so the server does not wait for an idle keep-alive socket.
    if (reason === "shutdown") socket?.end?.();
  };

  const handle: LiveStreamHandle = {
    userId: auth.userId,
    deviceId: auth.deviceId,
    authVersion: auth.authVersion,
    expiresAt: auth.tokenExpiresAt,
    send: (event) => {
      write(sseEventFrame(event));
    },
    ping: (now) => {
      write(sseHeartbeatFrame(now));
    },
    close: end,
  };

  raw.on("close", finish);
  raw.on("error", (error) => {
    request.log.debug({ err: error }, "live stream connection error");
    finish();
  });

  try {
    write(sseRetryFrame(SSE_RETRY_MS));
    registration = hub.register(handle);
    const stream = registration.stream;
    const connected = buildLiveEvent(
      "system.connected",
      { heartbeatMs: deps.heartbeatMs, retryMs: SSE_RETRY_MS },
      ctx.clock.now(),
    );
    write(sseEventFrame(connected));
    const delay = Math.min(Math.max(0, stream.expiresAt - ctx.clock.now()), MAX_TIMER_MS);
    expiry = timers.setTimeout(() => {
      hub.closeStream(stream, "expired");
    }, delay);
    deps.heartbeat.start();
    request.log.debug({ streams: hub.count(auth.userId) }, "live stream opened");
  } catch (error) {
    request.log.warn({ err: error }, "live stream failed to open");
    if (registration !== null) hub.closeStream(registration.stream, "broken");
    finish();
    raw.destroy();
  }
}

export function registerLiveRoutes(app: FastifyInstance, ctx: AppContext): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const heartbeatMs = ctx.env.SSE_HEARTBEAT_SECONDS * SECOND_MS;
  const heartbeat = new LiveHeartbeat({
    hub: ctx.live,
    timers: ctx.live.timers,
    intervalMs: heartbeatMs,
    log: ctx.log,
    revalidate: (streams) => revalidateStreams({ db: ctx.db, hub: ctx.live }, streams),
  });
  // `preClose` (app.ts) closed the streams; the loop stops and a recheck in flight ends before the database closes.
  app.addHook("onClose", async () => {
    await heartbeat.stop();
  });
  const deps: StreamDeps = { ctx, heartbeat, heartbeatMs };

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
    (request, reply) => {
      const auth = requireAuth(request);
      // The guard checked `exp` a moment ago; a token that expired since opens nothing.
      if (auth.tokenExpiresAt <= ctx.clock.now()) throw new AppError("access_token_expired");
      openStream(deps, request, reply, auth);
    },
  );
}
