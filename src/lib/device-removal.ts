/**
 * Removing devices: the single path of DESIGN §4.6 (frozen after M0, PLAN general rules item 2). Removing a device
 * **is** revoking its session: revoke, revoke-others, logout, refresh token reuse, recover, password change with
 * "sign out other devices", account deletion, the CLI and the inactive-device cleanup all go through here.
 *
 * 1. {@link removeDevicesInTx}, inside the caller's `db.write`:
 *    - unfinished links (`pending|claimed|approved`) approved by a removed device become `cancelled`, and their
 *      network hints are erased (API §9.2: `*_net` are erased in a final status);
 *    - `DELETE FROM devices`; refresh tokens go by `ON DELETE CASCADE`.
 * 2. {@link afterRemove}, strictly **after commit** (docs/database.md §2.4), with the value step 1 returned:
 *    addressed `session.invalidated{reason}` → `live.closeDevice` → `devices.updated` to the remaining devices.
 *
 * Which events a reason produces (API §6; API §5: background jobs publish no SSE):
 *
 * | reason              | `session.invalidated` to the removed device | `devices.updated` to the others |
 * | ------------------- | ------------------------------------------- | ------------------------------- |
 * | `device_revoked`    | `device_revoked`                            | `device_removed`                |
 * | `device_signed_out` | — (the device logged out itself)            | `device_signed_out`             |
 * | `token_reuse`       | `token_reuse`                               | `device_removed`                |
 * | `password_changed`  | `password_changed`                          | `device_removed`                |
 * | `recovery_reset`    | `recovery_reset`                            | — (every device is gone)        |
 * | `account_deleted`   | `account_deleted`, then `closeUser`         | — (every device is gone)        |
 * | `inactive`          | — (background job)                          | —                               |
 *
 * Streams of a removed device are always closed.
 */
import type { Queryable } from "../db/index.ts";
import { IN_BATCH_VALUES, chunks } from "../db/batch.ts";
import { TxRuleError, currentTxScope } from "../db/tx.ts";

export type RemovalReason =
  | "device_revoked"
  | "device_signed_out"
  | "token_reuse"
  | "password_changed"
  | "recovery_reset"
  | "account_deleted"
  | "inactive";

/** What {@link removeDevicesInTx} removed; hand it to {@link afterRemove} after the commit. */
export type RemovedDevices = Readonly<{
  userId: string;
  /** Devices that existed and were deleted, in the order given (duplicates and unknown ids dropped). */
  deviceIds: readonly string[];
  reason: RemovalReason;
}>;

/** Link statuses that are not final (DESIGN §4.10.3); `expired` is computed and never stored. */
export const UNFINISHED_LINK_STATUSES = ["pending", "claimed", "approved"] as const;

function assertWrite(what: string): void {
  if (currentTxScope()?.kind !== "write") throw new TxRuleError(`${what} must be called inside db.write`);
}

/**
 * Removes the given devices of the user inside the current `db.write` (step 1 above). Ids of other users' devices
 * are ignored. Call {@link afterRemove} with the result after the transaction committed.
 * @throws TxRuleError outside `db.write`.
 */
export async function removeDevicesInTx(
  q: Queryable,
  userId: string,
  deviceIds: readonly string[],
  reason: RemovalReason,
): Promise<RemovedDevices> {
  assertWrite("removeDevicesInTx");
  const unique = [...new Set(deviceIds)];
  const removed = new Set<string>();
  for (const chunk of chunks(unique, IN_BATCH_VALUES)) {
    const owned = await q
      .selectFrom("devices")
      .select("id")
      .where("user_id", "=", userId)
      .where("id", "in", chunk)
      .execute();
    const ids = owned.map((row) => row.id);
    if (ids.length === 0) continue;
    await q
      .updateTable("device_links")
      .set({ status: "cancelled", creator_net: null, other_net: null })
      .where("approver_device_id", "in", ids)
      .where("status", "in", UNFINISHED_LINK_STATUSES)
      .execute();
    const deleted = await q
      .deleteFrom("devices")
      .where("user_id", "=", userId)
      .where("id", "in", ids)
      .returning("id")
      .execute();
    for (const row of deleted) removed.add(row.id);
  }
  return Object.freeze({
    userId,
    deviceIds: Object.freeze(unique.filter((id) => removed.has(id))),
    reason,
  });
}

/**
 * Removes every device of the user, optionally except one (recover, account deletion, revoke-others after the
 * policy check). Same rules as {@link removeDevicesInTx}.
 */
export async function removeAllDevicesInTx(
  q: Queryable,
  userId: string,
  reason: RemovalReason,
  options: Readonly<{ exceptDeviceId?: string }> = {},
): Promise<RemovedDevices> {
  assertWrite("removeAllDevicesInTx");
  let query = q.selectFrom("devices").select("id").where("user_id", "=", userId);
  if (options.exceptDeviceId !== undefined) query = query.where("id", "<>", options.exceptDeviceId);
  const rows = await query.orderBy("id").execute();
  return removeDevicesInTx(
    q,
    userId,
    rows.map((row) => row.id),
    reason,
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// After commit
// ---------------------------------------------------------------------------------------------------------------------

/** Who receives a live event: one device only, or every device of the user except one; default: every device. */
export type LiveTarget = Readonly<{ onlyDeviceId?: string; exceptDeviceId?: string }>;

/**
 * The part of the live hub (`src/modules/live/live.hub.ts`) that device removal uses. The hub builds the
 * `LiveEvent` envelope (`id`, `at`) itself.
 */
export type RemovalLive = Readonly<{
  publish(userId: string, type: "session.invalidated" | "devices.updated", payload: object, target?: LiveTarget): void;
  closeDevice(userId: string, deviceId: string): void;
  closeUser(userId: string): void;
}>;

export type SessionInvalidatedReason =
  "device_revoked" | "password_changed" | "recovery_reset" | "token_reuse" | "account_deleted";

export type DevicesUpdatedReason = "device_added" | "device_removed" | "device_renamed" | "device_signed_out";

type RemovalEffects = Readonly<{
  invalidated: SessionInvalidatedReason | null;
  devicesUpdated: DevicesUpdatedReason | null;
  closeUser: boolean;
}>;

export const REMOVAL_EFFECTS: Readonly<Record<RemovalReason, RemovalEffects>> = Object.freeze({
  device_revoked: { invalidated: "device_revoked", devicesUpdated: "device_removed", closeUser: false },
  device_signed_out: { invalidated: null, devicesUpdated: "device_signed_out", closeUser: false },
  token_reuse: { invalidated: "token_reuse", devicesUpdated: "device_removed", closeUser: false },
  password_changed: { invalidated: "password_changed", devicesUpdated: "device_removed", closeUser: false },
  recovery_reset: { invalidated: "recovery_reset", devicesUpdated: null, closeUser: false },
  account_deleted: { invalidated: "account_deleted", devicesUpdated: null, closeUser: true },
  inactive: { invalidated: null, devicesUpdated: null, closeUser: false },
});

export type AfterRemoveOptions = Readonly<{
  /** Receives errors of the hub; the commit already happened, so they must not fail the request. */
  onError?: (error: unknown) => void;
}>;

/**
 * Live effects of a committed removal (step 2 above), in the order of DESIGN §4.6. `devices.updated` names the
 * device when exactly one was removed, otherwise `deviceId: null` ("the list changed").
 */
export function afterRemove(live: RemovalLive, removed: RemovedDevices, options: AfterRemoveOptions = {}): void {
  const effects = REMOVAL_EFFECTS[removed.reason];
  const { userId, deviceIds } = removed;
  const safely = (action: () => void) => {
    try {
      action();
    } catch (error) {
      options.onError?.(error);
    }
  };

  for (const deviceId of deviceIds) {
    if (effects.invalidated !== null) {
      const payload = { reason: effects.invalidated, forceRelogin: true };
      safely(() => {
        live.publish(userId, "session.invalidated", payload, { onlyDeviceId: deviceId });
      });
    }
    safely(() => {
      live.closeDevice(userId, deviceId);
    });
  }
  if (effects.closeUser) {
    safely(() => {
      live.closeUser(userId);
    });
  }
  if (effects.devicesUpdated !== null && deviceIds.length > 0) {
    const payload = {
      reason: effects.devicesUpdated,
      deviceId: deviceIds.length === 1 ? (deviceIds[0] ?? null) : null,
    };
    safely(() => {
      live.publish(userId, "devices.updated", payload);
    });
  }
}

/** `ctx.devices` of DESIGN §4.4: `ctx.devices.afterRemove(out.removed)`. */
export type DeviceRemovalEffects = Readonly<{ afterRemove(removed: RemovedDevices): void }>;

export function deviceRemovalEffects(live: RemovalLive, options: AfterRemoveOptions = {}): DeviceRemovalEffects {
  return Object.freeze({
    afterRemove: (removed: RemovedDevices) => {
      afterRemove(live, removed, options);
    },
  });
}
