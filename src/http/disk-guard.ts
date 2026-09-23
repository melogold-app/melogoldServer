/**
 * Disk guard (DESIGN §3.10, API §2.2 `storage_full`, API §5 background job "disk-guard раз в минуту").
 *
 * While the free space of `DATA_DIR` is below `DISK_MIN_FREE_PERCENT`, writes that grow the data answer
 * `503 storage_full` (`retryAfterSeconds: 600`): registration, `PUT /playback/state` and `/sync` with ops. Pull and
 * login keep working. The state is refreshed by {@link DiskGuard.check} (the scheduler, or {@link DiskGuard.start});
 * the request path only reads the last result.
 */
import { statfs as statfsAsync } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { MINUTE_MS } from "../lib/clock.ts";
import { AppError } from "./errors.ts";

export const STORAGE_FULL_RETRY_AFTER_SECONDS = 600;
export const DISK_CHECK_INTERVAL_MS = MINUTE_MS;

export type DiskSpace = Readonly<{ bavail: number | bigint; blocks: number | bigint }>;

export type DiskStatus = Readonly<{
  /** Free space available to the server, percent of the file system (0..100). */
  freePercent: number;
  full: boolean;
  checkedAt: number;
}>;

export type DiskGuardLogger = Readonly<{
  warn(details: object, message: string): void;
  info(details: object, message: string): void;
}>;

export type DiskGuardOptions = Readonly<{
  /** `DATA_DIR`. */
  path: string;
  /** `DISK_MIN_FREE_PERCENT`. */
  minFreePercent: number;
  log?: DiskGuardLogger;
  now?: () => number;
  /** `fs.promises.statfs` (tests inject a fake). */
  statfs?: (path: string) => Promise<DiskSpace>;
}>;

export type DiskGuard = Readonly<{
  /** Measures the free space now and remembers the result; errors keep the previous state and are logged. */
  check(): Promise<DiskStatus | null>;
  /** The last measurement (`null` before the first successful one). */
  status(): DiskStatus | null;
  isFull(): boolean;
  /** @throws AppError `503 storage_full` while the disk is low. */
  assertWritable(): void;
  /** Checks now and then every `intervalMs` (the timer does not keep the process alive). */
  start(intervalMs?: number): void;
  stop(): void;
}>;

export function storageFullError(): AppError<"storage_full"> {
  return new AppError("storage_full", { details: { retryAfterSeconds: STORAGE_FULL_RETRY_AFTER_SECONDS } });
}

const silent: DiskGuardLogger = { warn: () => undefined, info: () => undefined };

export function createDiskGuard(options: DiskGuardOptions): DiskGuard {
  const statfs = options.statfs ?? ((path: string) => statfsAsync(path));
  const now = options.now ?? Date.now;
  const log = options.log ?? silent;
  let current: DiskStatus | null = null;
  let timer: NodeJS.Timeout | null = null;

  async function check(): Promise<DiskStatus | null> {
    try {
      const space = await statfs(options.path);
      const blocks = Number(space.blocks);
      const freePercent = blocks > 0 ? (Number(space.bavail) / blocks) * 100 : 100;
      const full = freePercent < options.minFreePercent;
      const next: DiskStatus = Object.freeze({ freePercent, full, checkedAt: now() });
      if (full && current?.full !== true) {
        log.warn(
          { freePercent: Math.round(freePercent * 10) / 10, minFreePercent: options.minFreePercent },
          "disk space is low: writes answer 503 storage_full",
        );
      } else if (!full && current?.full === true) {
        log.info({ freePercent: Math.round(freePercent * 10) / 10 }, "disk space recovered");
      }
      current = next;
    } catch (error) {
      log.warn({ err: error }, "could not measure free disk space");
    }
    return current;
  }

  return Object.freeze({
    check,
    status: () => current,
    isFull: () => current?.full === true,
    assertWritable: () => {
      if (current?.full === true) throw storageFullError();
    },
    start: (intervalMs = DISK_CHECK_INTERVAL_MS) => {
      if (timer) return;
      void check();
      timer = setInterval(() => void check(), intervalMs);
      timer.unref();
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  });
}

function hasOps(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const ops = (body as { ops?: unknown }).ops;
  return Array.isArray(ops) && ops.length > 0;
}

/** Refuses the routes whose policy has `storage` while the disk is low (`preHandler`, after validation). */
export function registerStorageCheck(app: FastifyInstance, guard: Pick<DiskGuard, "assertWritable">): void {
  app.addHook("preHandler", (request, _reply, done) => {
    const storage = request.routeOptions.config.policy?.storage ?? null;
    try {
      if (storage === "always" || (storage === "with_ops" && hasOps(request.body))) guard.assertWritable();
      done();
    } catch (error) {
      done(error as AppError);
    }
  });
}
