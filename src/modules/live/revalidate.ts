/**
 * The heartbeat of the live streams and the batched recheck of their devices (DESIGN §4.7, API §6, PLAN T1.5).
 *
 * A device removed or an `auth_version` raised **in this process** closes its streams at once: the services call
 * `ctx.devices.afterRemove` / `ctx.live.closeUser` after the commit. Changes made elsewhere (the CLI in a neighbouring
 * process, a restored backup) are caught here, at most one heartbeat later:
 *
 * 1. {@link LiveHeartbeat}: while at least one stream is open, every `SSE_HEARTBEAT_SECONDS` it calls
 *    `hub.heartbeat()` (a `: heartbeat <ms>` comment to every stream, streams past their token's `exp` closed), then
 *    {@link revalidateStreams} for the streams open at that moment. Rechecks never overlap: a beat that finds the
 *    previous one still running only writes the heartbeats. With no stream left the loop stops; the next stream
 *    starts it again.
 * 2. {@link revalidateStreams}: one query per 1000 devices ({@link findDeviceSessions}: `devices ⋈ users` by
 *    `devices.id IN (…)`, like step 3 of the guard, API §1.7), then {@link planRevalidation}:
 *    - the device is gone (or belongs to another user) → `session.invalidated{device_revoked}` to that device, then
 *      its streams close (`closeDevice`);
 *    - the user is deleted (`deleted_at` set) → the same with `account_deleted`;
 *    - `users.auth_version` differs from the stream's `av` → that stream closes without an event.
 *
 * Only reads; no transaction (each chunk is one `db.run`), so HTTP requests can use the single SQLite connection
 * between chunks.
 */
import type { SessionInvalidatedReason } from "../../contract/live.ts";
import { selectInChunks } from "../../db/batch.ts";
import type { Db, Queryable } from "../../db/index.ts";
import type { LiveHub, LiveStream, LiveTimers } from "./live.hub.ts";

/** A device as the recheck sees it. */
export type DeviceSession = Readonly<{
  deviceId: string;
  userId: string;
  authVersion: number;
  /** `users.deleted_at`: set when the account was deleted (logically). */
  userDeletedAt: number | null;
}>;

/**
 * The devices among `deviceIds` with the `auth_version` and `deleted_at` of their user; missing devices are simply
 * absent. One statement: at most 1000 ids (`IN_BATCH_VALUES`), never empty (`selectInChunks` chunks).
 */
export function findDeviceSessions(q: Queryable, deviceIds: readonly string[]): Promise<DeviceSession[]> {
  return q
    .selectFrom("devices")
    .innerJoin("users", "users.id", "devices.user_id")
    .select([
      "devices.id as deviceId",
      "devices.user_id as userId",
      "users.auth_version as authVersion",
      "users.deleted_at as userDeletedAt",
    ])
    .where("devices.id", "in", [...deviceIds])
    .execute();
}

/** A device whose session is gone: its streams get `session.invalidated{reason}` and close. */
export type InvalidatedDevice = Readonly<{ userId: string; deviceId: string; reason: SessionInvalidatedReason }>;

export type RevalidationPlan = Readonly<{
  /** One entry per device, in the order the streams were given. */
  invalidated: readonly InvalidatedDevice[];
  /** Streams of live devices whose `av` is not the user's `auth_version`: closed without an event. */
  outdated: readonly LiveStream[];
}>;

/** What the rows say about each stream (pure; see the module comment). */
export function planRevalidation(streams: readonly LiveStream[], sessions: readonly DeviceSession[]): RevalidationPlan {
  const byDevice = new Map(sessions.map((session) => [session.deviceId, session]));
  const invalidated = new Map<string, InvalidatedDevice>();
  const outdated: LiveStream[] = [];
  for (const stream of streams) {
    const session = byDevice.get(stream.deviceId);
    const key = `${stream.userId}\u0000${stream.deviceId}`;
    if (session?.userId !== stream.userId) {
      if (!invalidated.has(key)) {
        invalidated.set(key, { userId: stream.userId, deviceId: stream.deviceId, reason: "device_revoked" });
      }
    } else if (session.userDeletedAt !== null) {
      if (!invalidated.has(key)) {
        invalidated.set(key, { userId: stream.userId, deviceId: stream.deviceId, reason: "account_deleted" });
      }
    } else if (session.authVersion !== stream.authVersion) {
      outdated.push(stream);
    }
  }
  return Object.freeze({ invalidated: [...invalidated.values()], outdated });
}

/** The part of the hub a recheck acts on. */
export type RevalidationHub = Pick<LiveHub, "publish" | "closeDevice" | "closeStream">;

/** Applies a plan: `session.invalidated` then `closeDevice` per device (DESIGN §4.6 order), then the outdated streams. */
export function applyRevalidation(hub: RevalidationHub, plan: RevalidationPlan): void {
  for (const { userId, deviceId, reason } of plan.invalidated) {
    hub.publish(userId, "session.invalidated", { reason, forceRelogin: true }, { onlyDeviceId: deviceId });
    hub.closeDevice(userId, deviceId);
  }
  for (const stream of plan.outdated) hub.closeStream(stream, "outdated");
}

export type RevalidateDeps = Readonly<{ db: Pick<Db, "run">; hub: RevalidationHub }>;

/** Rechecks the devices of `streams` in the database and acts on the result (see the module comment). */
export async function revalidateStreams(
  deps: RevalidateDeps,
  streams: readonly LiveStream[],
): Promise<RevalidationPlan> {
  if (streams.length === 0) return Object.freeze({ invalidated: [], outdated: [] });
  const sessions = await selectInChunks(
    streams.map((stream) => stream.deviceId),
    (chunk) => deps.db.run((q) => findDeviceSessions(q, chunk)),
  );
  const plan = planRevalidation(streams, sessions);
  applyRevalidation(deps.hub, plan);
  return plan;
}

export type LiveHeartbeatLogger = Readonly<{ error(details: object, message: string): void }>;

export type LiveHeartbeatOptions = Readonly<{
  hub: Pick<LiveHub, "heartbeat" | "streams">;
  timers: LiveTimers;
  /** `SSE_HEARTBEAT_SECONDS` in milliseconds. */
  intervalMs: number;
  /** The recheck of one beat, given the streams open at that moment ({@link revalidateStreams}). */
  revalidate(streams: readonly LiveStream[]): Promise<unknown>;
  log: LiveHeartbeatLogger;
}>;

/** The heartbeat loop (step 1 of the module comment). */
export class LiveHeartbeat {
  readonly #hub: LiveHeartbeatOptions["hub"];
  readonly #timers: LiveTimers;
  readonly #intervalMs: number;
  readonly #revalidate: LiveHeartbeatOptions["revalidate"];
  readonly #log: LiveHeartbeatLogger;
  #timer: unknown = null;
  #running: Promise<void> | null = null;
  #stopped = false;

  constructor(options: LiveHeartbeatOptions) {
    if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1) {
      throw new RangeError("intervalMs must be a positive integer");
    }
    this.#hub = options.hub;
    this.#timers = options.timers;
    this.#intervalMs = options.intervalMs;
    this.#revalidate = options.revalidate;
    this.#log = options.log;
  }

  /** Whether a beat is scheduled. */
  get active(): boolean {
    return this.#timer !== null;
  }

  /** Schedules the next beat unless one is scheduled already (called for every new stream). */
  start(): void {
    if (this.#stopped || this.#timer !== null) return;
    this.#timer = this.#timers.setTimeout(() => {
      this.#beat();
    }, this.#intervalMs);
  }

  /** Stops the loop for good and waits for a recheck in flight (`onClose`, before the database closes). */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== null) this.#timers.clearTimeout(this.#timer);
    this.#timer = null;
    await this.#running;
  }

  #beat(): void {
    this.#timer = null;
    this.#hub.heartbeat();
    const streams = this.#hub.streams();
    if (streams.length === 0) return;
    this.start();
    if (this.#running !== null) return;
    this.#running = this.#revalidate(streams)
      .then(
        () => undefined,
        (error: unknown) => {
          this.#log.error({ err: error }, "live streams: the heartbeat recheck of devices failed");
        },
      )
      .finally(() => {
        this.#running = null;
      });
  }
}
