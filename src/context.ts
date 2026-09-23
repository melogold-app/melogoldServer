/**
 * The application context `ctx` (DESIGN §6.3): everything a service needs besides the request, created once per
 * process by `server.ts` (or per test by `src/test/test-app.ts`) and passed to every route module. Frozen after M0
 * (PLAN, general rules item 2).
 *
 * | Member      | What                                                                                     |
 * | ----------- | ---------------------------------------------------------------------------------------- |
 * | `env`       | the parsed environment (API §10); nothing else reads `process.env`                       |
 * | `clock`     | the only source of time (epoch ms)                                                       |
 * | `log`       | the server logger (pino of Fastify, masked); request code prefers `request.log`          |
 * | `db`        | `db.read` / `db.write` / `db.run` (`src/db`, docs/database.md)                           |
 * | `serverId`  | `server_meta.server_id` (API §4.2)                                                       |
 * | `keys`      | HKDF subkeys of the master key: `jwtAccess`, `refreshToken`, `pow` (DESIGN §4.13)        |
 * | `live`      | the SSE hub: `publish`, `publishCoalesced`, `closeDevice`, `closeUser`, `closeAll`       |
 * | `devices`   | `afterRemove(removed)` after a committed device removal, `touchLastSync(deviceId)`       |
 * | `features`  | `ServerInfo.features` declared by the modules that implement them                        |
 * | `diskGuard` | the free-space state behind `503 storage_full`                                           |
 * | `lifecycle` | draining during shutdown (`/health` → 503, new requests refused)                         |
 * | `random`    | uniform [0, 1) for jitter (tests inject a fixed one)                                     |
 */
import type { Env } from "./config/env.ts";
import type { Subkeys } from "./config/secret-key.ts";
import type { Db } from "./db/index.ts";
import { createDiskGuard } from "./http/disk-guard.ts";
import type { DiskGuard } from "./http/disk-guard.ts";
import { systemClock } from "./lib/clock.ts";
import type { Clock } from "./lib/clock.ts";
import { createLastSyncToucher } from "./lib/device-activity.ts";
import { deviceRemovalEffects } from "./lib/device-removal.ts";
import type { RemovedDevices } from "./lib/device-removal.ts";
import { LiveHub } from "./modules/live/live.hub.ts";
import type { LiveTimers } from "./modules/live/live.hub.ts";
import { FeatureRegistry } from "./modules/server/features.ts";

/**
 * The logger shape the context uses: pino's `(details, message)` calls. Fastify's `app.log` fits, and so does any
 * structured logger of the CLI.
 */
export type AppLogger = Readonly<{
  trace(details: object, message: string): void;
  debug(details: object, message: string): void;
  info(details: object, message: string): void;
  warn(details: object, message: string): void;
  error(details: object, message: string): void;
  fatal(details: object, message: string): void;
}>;

const ignore = (): undefined => undefined;

/** A logger that drops everything (tests, tools). */
export const silentLogger: AppLogger = Object.freeze({
  trace: ignore,
  debug: ignore,
  info: ignore,
  warn: ignore,
  error: ignore,
  fatal: ignore,
});

/** `ctx.devices` (DESIGN §3.8, §4.6). */
export type DeviceEffects = Readonly<{
  /** Live effects of a committed removal: `session.invalidated` → `closeDevice` → `devices.updated`. Never throws. */
  afterRemove(removed: RemovedDevices): void;
  /** `last_sync_at = now`, at most once a minute per device, fire-and-forget. */
  touchLastSync(deviceId: string): void;
  /** Resolves when pending `touchLastSync` writes finished (tests, shutdown). */
  idle(): Promise<void>;
}>;

/** Shutdown state (`server.ts`): once draining, `/health` answers 503 and new requests are refused. */
export type Lifecycle = Readonly<{
  isDraining(): boolean;
  startDraining(): void;
}>;

export function createLifecycle(): Lifecycle {
  let draining = false;
  return Object.freeze({
    isDraining: () => draining,
    startDraining: () => {
      draining = true;
    },
  });
}

export type AppContext = Readonly<{
  env: Env;
  clock: Clock;
  log: AppLogger;
  db: Db;
  serverId: string;
  keys: Subkeys;
  live: LiveHub;
  devices: DeviceEffects;
  features: FeatureRegistry;
  diskGuard: DiskGuard;
  lifecycle: Lifecycle;
  random: () => number;
}>;

export type CreateAppContextInput = Readonly<{
  env: Env;
  db: Db;
  serverId: string;
  keys: Subkeys;
  log?: AppLogger;
  clock?: Clock;
  random?: () => number;
  /** Default: a disk guard on `DATA_DIR` with `DISK_MIN_FREE_PERCENT` (checked by the `disk-guard` job). */
  diskGuard?: DiskGuard;
  /** Timers of the live hub's coalescing (tests). */
  liveTimers?: LiveTimers;
}>;

/** Assembles `ctx`. Performs no I/O: the database is open and migrated, the keys derived, by the caller. */
export function createAppContext(input: CreateAppContextInput): AppContext {
  const { env, db } = input;
  const log = input.log ?? silentLogger;
  const clock = input.clock ?? systemClock;
  const live = new LiveHub({
    clock,
    log,
    maxStreamsPerDevice: env.SSE_MAX_STREAMS_PER_DEVICE,
    maxStreamsPerUser: env.SSE_MAX_STREAMS_PER_USER,
    ...(input.liveTimers ? { timers: input.liveTimers } : {}),
  });
  const removal = deviceRemovalEffects(live, {
    onError: (error) => {
      log.error({ err: error }, "live effects of a device removal failed");
    },
  });
  const lastSync = createLastSyncToucher({ db, clock, log });
  const devices: DeviceEffects = Object.freeze({
    afterRemove: removal.afterRemove,
    touchLastSync: lastSync.touchLastSync,
    idle: lastSync.idle,
  });
  const diskGuard =
    input.diskGuard ??
    createDiskGuard({ path: env.DATA_DIR, minFreePercent: env.DISK_MIN_FREE_PERCENT, log, now: () => clock.now() });
  return Object.freeze({
    env,
    clock,
    log,
    db,
    serverId: input.serverId,
    keys: input.keys,
    live,
    devices,
    features: new FeatureRegistry(),
    diskGuard,
    lifecycle: createLifecycle(),
    random: input.random ?? Math.random,
  });
}
