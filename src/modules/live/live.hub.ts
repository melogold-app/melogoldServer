/**
 * The live hub (`ctx.live`, DESIGN §4.7, API §6): the streams of `GET /auth/me/events` open in this process and the
 * delivery of events to them. One process holds every stream (DESIGN §11: `--scale` is not supported).
 *
 * - {@link LiveHub.register} adds a stream; beyond `SSE_MAX_STREAMS_PER_DEVICE` (4) streams of one device or
 *   `SSE_MAX_STREAMS_PER_USER` (64) of one user the **oldest** stream is closed (API §6 "Лимиты").
 * - {@link LiveHub.publish} delivers one event now: to every device of the user, to one device (`onlyDeviceId`) or
 *   to every device but one (`exceptDeviceId`). It is called only **after commit** and never throws: a bad payload
 *   or a failing stream is logged and skipped.
 * - {@link LiveHub.publishCoalesced} throttles an event type per user (API §6 `sync.changed`: 2 s): the first event
 *   of a quiet period goes out at once, later ones inside the window merge into one trailing event with the latest
 *   payload. The trailing event skips the author only when every merged event had the same author.
 * - {@link LiveHub.closeDevice}, {@link LiveHub.closeUser} and {@link LiveHub.closeAll} (shutdown) close streams.
 *
 * The hub knows nothing about HTTP: a stream is a `send`/`close` pair supplied by the route (T1.5), which writes the
 * frames of `live.events.ts`. Owned by T1.5 after M0 (PLAN).
 */
import type { Clock } from "../../lib/clock.ts";
import type { LiveTarget, RemovalLive } from "../../lib/device-removal.ts";
import { newId } from "../../lib/ids.ts";
import { buildLiveEvent, LIVE_EVENTS } from "./live.events.ts";
import type { LiveEvent, LiveEventType, LivePayload } from "./live.events.ts";

export type { LiveTarget };

/** Why the hub closed a stream (the route may log it; clients only see the connection end). */
export type LiveCloseReason = "evicted" | "device_closed" | "user_closed" | "shutdown";

/** A stream as the route registers it. */
export type LiveStreamHandle = Readonly<{
  userId: string;
  deviceId: string;
  /** `av` of the access token the stream was opened with (a newer `auth_version` closes it, DESIGN §4.7). */
  authVersion: number;
  /** `exp` of that token, epoch ms: the stream closes at this moment. */
  expiresAt: number;
  /** Writes one event frame; may throw when the connection is gone (the hub then drops the stream). */
  send(event: LiveEvent): void;
  /** Ends the connection. Called once, after the hub forgot the stream. */
  close(reason: LiveCloseReason): void;
}>;

/** A registered stream. */
export type LiveStream = LiveStreamHandle & Readonly<{ id: string; openedAt: number }>;

export type LiveRegistration = Readonly<{
  stream: LiveStream;
  /** Forgets the stream without calling its `close` (the client went away). Idempotent. */
  unregister(): void;
}>;

export type LiveHubLogger = Readonly<{
  warn(details: object, message: string): void;
  error(details: object, message: string): void;
}>;

/** Timer functions (tests inject fakes). */
export type LiveTimers = Readonly<{
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}>;

export type LiveHubOptions = Readonly<{
  clock: Clock;
  log: LiveHubLogger;
  /** `SSE_MAX_STREAMS_PER_DEVICE`. */
  maxStreamsPerDevice: number;
  /** `SSE_MAX_STREAMS_PER_USER`. */
  maxStreamsPerUser: number;
  timers?: LiveTimers;
  newId?: () => string;
}>;

export type CoalesceOptions = Readonly<{
  /** The author's device: it does not receive the event (DESIGN §3.8 `{ excludeDeviceId: auth.deviceId }`). */
  excludeDeviceId?: string;
  /** Window in ms; default: `coalesceMs` of the type in `live.events.ts`, else 2 s. */
  windowMs?: number;
}>;

const DEFAULT_COALESCE_MS = 2000;

const realTimers: LiveTimers = Object.freeze({
  setTimeout: (callback: () => void, ms: number) => {
    const handle = setTimeout(callback, ms);
    handle.unref();
    return handle;
  },
  clearTimeout: (handle: unknown) => {
    clearTimeout(handle as NodeJS.Timeout);
  },
});

type CoalesceSlot = {
  timer: unknown;
  windowMs: number;
  pending: { payload: unknown; authors: Set<string | null> } | null;
};

export class LiveHub implements RemovalLive {
  readonly #clock: Clock;
  readonly #log: LiveHubLogger;
  readonly #maxPerDevice: number;
  readonly #maxPerUser: number;
  readonly #timers: LiveTimers;
  readonly #newId: () => string;
  /** userId → streams in opening order (oldest first). */
  readonly #byUser = new Map<string, LiveStream[]>();
  readonly #coalesce = new Map<string, CoalesceSlot>();

  constructor(options: LiveHubOptions) {
    if (!Number.isInteger(options.maxStreamsPerDevice) || options.maxStreamsPerDevice < 1) {
      throw new RangeError("maxStreamsPerDevice must be a positive integer");
    }
    if (!Number.isInteger(options.maxStreamsPerUser) || options.maxStreamsPerUser < 1) {
      throw new RangeError("maxStreamsPerUser must be a positive integer");
    }
    this.#clock = options.clock;
    this.#log = options.log;
    this.#maxPerDevice = options.maxStreamsPerDevice;
    this.#maxPerUser = options.maxStreamsPerUser;
    this.#timers = options.timers ?? realTimers;
    this.#newId = options.newId ?? newId;
  }

  /** Adds a stream, closing the oldest ones beyond the per-device and per-user limits. */
  register(handle: LiveStreamHandle): LiveRegistration {
    const stream: LiveStream = Object.freeze({ ...handle, id: this.#newId(), openedAt: this.#clock.now() });
    const list = this.#byUser.get(stream.userId) ?? [];
    list.push(stream);
    this.#byUser.set(stream.userId, list);

    const ofDevice = list.filter((item) => item.deviceId === stream.deviceId);
    const evicted = new Set(ofDevice.slice(0, Math.max(0, ofDevice.length - this.#maxPerDevice)));
    const remaining = list.filter((item) => !evicted.has(item));
    for (const item of remaining.slice(0, Math.max(0, remaining.length - this.#maxPerUser))) evicted.add(item);
    for (const item of evicted) this.#close(item, "evicted");

    return Object.freeze({
      stream,
      unregister: () => {
        this.#forget(stream);
      },
    });
  }

  /** Every stream open now (for the heartbeat revalidation of T1.5). */
  streams(): readonly LiveStream[] {
    return [...this.#byUser.values()].flat();
  }

  /** Number of open streams (of one user, or in total). */
  count(userId?: string): number {
    if (userId !== undefined) return this.#byUser.get(userId)?.length ?? 0;
    let total = 0;
    for (const list of this.#byUser.values()) total += list.length;
    return total;
  }

  /**
   * Delivers an event now. Never throws: an invalid payload is logged and dropped, a stream whose `send` throws is
   * closed and forgotten.
   */
  publish<T extends LiveEventType>(userId: string, type: T, payload: LivePayload<T>, target: LiveTarget = {}): void {
    const recipients = this.#recipients(userId, target);
    if (recipients.length === 0) return;
    let event: LiveEvent;
    try {
      event = buildLiveEvent(type, payload, this.#clock.now(), this.#newId());
    } catch (error) {
      this.#log.error({ err: error, type }, "live event dropped: invalid payload");
      return;
    }
    for (const stream of recipients) {
      try {
        stream.send(event);
      } catch (error) {
        this.#log.warn({ err: error, type }, "live stream failed to send; closing it");
        this.#close(stream, "device_closed");
      }
    }
  }

  /**
   * Throttled {@link publish} per user and type: leading event at once, then at most one trailing event per window
   * carrying the latest payload.
   */
  publishCoalesced<T extends LiveEventType>(
    userId: string,
    type: T,
    payload: LivePayload<T>,
    options: CoalesceOptions = {},
  ): void {
    const key = `${userId}\u0000${type}`;
    const author = options.excludeDeviceId ?? null;
    const slot = this.#coalesce.get(key);
    if (slot) {
      const authors = slot.pending?.authors ?? new Set<string | null>();
      authors.add(author);
      slot.pending = { payload, authors };
      return;
    }
    const windowMs = options.windowMs ?? LIVE_EVENTS[type].coalesceMs ?? DEFAULT_COALESCE_MS;
    this.publish(userId, type, payload, author === null ? {} : { exceptDeviceId: author });
    const fresh: CoalesceSlot = { timer: null, windowMs, pending: null };
    fresh.timer = this.#timers.setTimeout(() => {
      this.#flush(key, userId, type);
    }, windowMs);
    this.#coalesce.set(key, fresh);
  }

  /** Closes every stream of one device (after `session.invalidated`, DESIGN §4.6). */
  closeDevice(userId: string, deviceId: string): void {
    for (const stream of [...(this.#byUser.get(userId) ?? [])]) {
      if (stream.deviceId === deviceId) this.#close(stream, "device_closed");
    }
  }

  /** Closes every stream of the user (account deleted, `auth_version` changed). */
  closeUser(userId: string): void {
    for (const stream of [...(this.#byUser.get(userId) ?? [])]) this.#close(stream, "user_closed");
  }

  /** Closes every stream and drops pending coalesced events (server shutdown, `preClose`). */
  closeAll(): void {
    for (const slot of this.#coalesce.values()) this.#timers.clearTimeout(slot.timer);
    this.#coalesce.clear();
    for (const stream of this.streams()) this.#close(stream, "shutdown");
  }

  #flush(key: string, userId: string, type: LiveEventType): void {
    const slot = this.#coalesce.get(key);
    if (!slot) return;
    if (slot.pending === null) {
      this.#coalesce.delete(key);
      return;
    }
    const { payload, authors } = slot.pending;
    slot.pending = null;
    const [only] = authors;
    const target: LiveTarget = authors.size === 1 && typeof only === "string" ? { exceptDeviceId: only } : {};
    this.publish(userId, type, payload as LivePayload<typeof type>, target);
    slot.timer = this.#timers.setTimeout(() => {
      this.#flush(key, userId, type);
    }, slot.windowMs);
  }

  #recipients(userId: string, target: LiveTarget): LiveStream[] {
    return (this.#byUser.get(userId) ?? []).filter(
      (stream) =>
        (target.onlyDeviceId === undefined || stream.deviceId === target.onlyDeviceId) &&
        (target.exceptDeviceId === undefined || stream.deviceId !== target.exceptDeviceId),
    );
  }

  #forget(stream: LiveStream): boolean {
    const list = this.#byUser.get(stream.userId);
    if (!list) return false;
    const index = list.indexOf(stream);
    if (index < 0) return false;
    list.splice(index, 1);
    if (list.length === 0) this.#byUser.delete(stream.userId);
    return true;
  }

  #close(stream: LiveStream, reason: LiveCloseReason): void {
    if (!this.#forget(stream)) return;
    try {
      stream.close(reason);
    } catch (error) {
      this.#log.warn({ err: error, reason }, "live stream failed to close");
    }
  }
}
