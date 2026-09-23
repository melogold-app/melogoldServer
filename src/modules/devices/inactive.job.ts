/**
 * Cleanup of inactive devices (DESIGN §4.6, §4.12): a device unused for `DEVICE_INACTIVE_DAYS` (`last_seen_at`
 * older than that) and without a live refresh token (not expired, not revoked, not rotated) is removed through
 * `removeDevicesInTx`, like every other removal. It is a step of the hourly `auth-cleanup` job, in batches of 1000
 * devices.
 *
 * - Candidates are found without a lock; each user's candidates are then re-checked and removed in one short
 *   `db.write` holding `lockUser`, so a device that a login just reused is never removed.
 * - Background jobs publish no SSE (API §5): the `inactive` reason sends no event; `afterRemove` only closes streams
 *   the device might still hold.
 * - The `signal` of the job stops the loop between users.
 */
import type { AppContext } from "../../context.ts";
import { lockUser } from "../../db/heads.ts";
import { DAY_MS } from "../../lib/clock.ts";
import { removeDevicesInTx } from "../../lib/device-removal.ts";
import { findInactiveDevices, stillInactiveDevices } from "./devices.repository.ts";
import type { InactiveCriteria } from "./devices.repository.ts";

/** DESIGN §4.12: the auth cleanup works in batches of 1000. */
export const INACTIVE_DEVICES_BATCH = 1000;

export type InactiveDevicesContext = Pick<AppContext, "db" | "clock" | "env" | "devices">;

export type RemoveInactiveOptions = Readonly<{
  signal?: AbortSignal;
  batchSize?: number;
  /** Lets HTTP requests take the SQLite writer between batches; default `setImmediate`. */
  yieldBetween?: () => Promise<void>;
}>;

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** `last_seen_at` before `now − DEVICE_INACTIVE_DAYS`, no live refresh token at `now`. */
export function inactiveCriteria(now: number, inactiveDays: number): InactiveCriteria {
  return { lastSeenBefore: now - inactiveDays * DAY_MS, now };
}

/**
 * Removes every inactive device, batch by batch.
 * @returns how many devices were removed.
 */
export async function removeInactiveDevices(
  ctx: InactiveDevicesContext,
  options: RemoveInactiveOptions = {},
): Promise<number> {
  const limit = options.batchSize ?? INACTIVE_DEVICES_BATCH;
  const pause = options.yieldBetween ?? yieldToEventLoop;
  const criteria = inactiveCriteria(ctx.clock.now(), ctx.env.DEVICE_INACTIVE_DAYS);
  const aborted = () => options.signal?.aborted === true;
  let total = 0;
  while (!aborted()) {
    const candidates = await ctx.db.run((q) => findInactiveDevices(q, criteria, limit));
    const byUser = new Map<string, string[]>();
    for (const device of candidates) byUser.set(device.userId, [...(byUser.get(device.userId) ?? []), device.id]);

    let removedNow = 0;
    for (const [userId, deviceIds] of byUser) {
      if (aborted()) break;
      const removed = await ctx.db.write(async (q) => {
        await lockUser(q, userId);
        const still = await stillInactiveDevices(q, userId, deviceIds, criteria);
        return removeDevicesInTx(q, userId, still, "inactive");
      });
      ctx.devices.afterRemove(removed);
      removedNow += removed.deviceIds.length;
    }
    total += removedNow;
    // A short batch was the last one; a batch that removed nothing would find the same candidates again.
    if (candidates.length < limit || removedNow === 0) break;
    await pause();
  }
  return total;
}
