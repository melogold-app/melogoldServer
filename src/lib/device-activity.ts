/**
 * `ctx.devices.touchLastSync(deviceId)` (DESIGN §3.8): after a `POST /sync` with ops the device's `last_sync_at` is
 * moved to now, **at most once a minute** per device. It runs after the response data is committed, outside any
 * transaction, and never fails the request: the write is fire-and-forget and its errors are logged.
 *
 * The in-memory map only saves queries; the `WHERE` clause keeps the rule across processes and restarts.
 */
import type { Db } from "../db/index.ts";
import { MINUTE_MS } from "./clock.ts";
import type { Clock } from "./clock.ts";

export const LAST_SYNC_INTERVAL_MS = MINUTE_MS;
/** Devices remembered by the throttle; beyond this the map is cleared (a few extra writes, never a wrong one). */
const MAX_REMEMBERED_DEVICES = 10_000;

export type DeviceActivityLogger = Readonly<{ warn(details: object, message: string): void }>;

export type LastSyncToucher = Readonly<{
  /** Schedules the write; returns at once. */
  touchLastSync(deviceId: string): void;
  /** Resolves when every scheduled write finished (tests, shutdown). Never rejects. */
  idle(): Promise<void>;
}>;

export function createLastSyncToucher(
  deps: Readonly<{ db: Pick<Db, "run">; clock: Clock; log: DeviceActivityLogger; intervalMs?: number }>,
): LastSyncToucher {
  const interval = deps.intervalMs ?? LAST_SYNC_INTERVAL_MS;
  const touchedAt = new Map<string, number>();
  const inFlight = new Set<Promise<void>>();

  const write = async (deviceId: string, now: number): Promise<void> => {
    try {
      await deps.db.run((q) =>
        q
          .updateTable("devices")
          .set({ last_sync_at: now })
          .where("id", "=", deviceId)
          .where((eb) => eb.or([eb("last_sync_at", "is", null), eb("last_sync_at", "<=", now - interval)]))
          .execute(),
      );
    } catch (error) {
      deps.log.warn({ err: error }, "could not update devices.last_sync_at");
    }
  };

  return Object.freeze({
    touchLastSync: (deviceId: string) => {
      const now = deps.clock.now();
      const last = touchedAt.get(deviceId);
      if (last !== undefined && now - last < interval) return;
      if (touchedAt.size >= MAX_REMEMBERED_DEVICES) touchedAt.clear();
      touchedAt.set(deviceId, now);
      const pending = write(deviceId, now);
      inFlight.add(pending);
      void pending.finally(() => inFlight.delete(pending));
    },
    idle: async () => {
      await Promise.all([...inFlight]);
    },
  });
}
