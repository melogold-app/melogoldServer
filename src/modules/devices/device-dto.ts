/**
 * API §4.1 `DeviceDto` from a `devices` row: the one place that turns a stored device into what clients see
 * (`GET /auth/me/devices`, `PATCH …/{deviceId}`; the other modules that answer a `DeviceDto` — `/auth/me`,
 * `AuthSession`, the export — can build it here too).
 *
 * - `name` is `customName ?? reportedName`;
 * - `recentUntil` is the end of the new-device restriction while it lasts (DESIGN §4.8, `policy.ts`), else `null`;
 * - times are API §1.5 strings.
 */
import type { DeviceDto } from "../../contract/common.ts";
import { formatIso, formatIsoOrNull } from "../../lib/time.ts";
import { recentUntil } from "../security/policy.ts";
import type { PolicyClock, PolicyDevice } from "../security/policy.ts";

/** A `devices` row as the services see it (camelCase; `hwid_hash` and `user_id` are never shown). */
export type DeviceRecord = Readonly<{
  id: string;
  reportedName: string;
  customName: string | null;
  platform: string;
  osVersion: string | null;
  model: string | null;
  clientVersion: string | null;
  linkedVia: string;
  linkedByDeviceId: string | null;
  createdAt: number;
  lastSeenAt: number;
  lastSyncAt: number | null;
}>;

/** The fields of the DESIGN §4.8 matrix. */
export function policyDevice(device: Pick<DeviceRecord, "id" | "linkedVia" | "createdAt">): PolicyDevice {
  return { id: device.id, linkedVia: device.linkedVia, createdAt: device.createdAt };
}

/** `now` and `NEW_DEVICE_RESTRICT_HOURS` for the matrix. */
export function policyClock(now: number, newDeviceRestrictHours: number): PolicyClock {
  return { now, newDeviceRestrictHours };
}

export function toDeviceDto(device: DeviceRecord, currentDeviceId: string, clock: PolicyClock): DeviceDto {
  return {
    id: device.id,
    name: device.customName ?? device.reportedName,
    reportedName: device.reportedName,
    customName: device.customName,
    platform: device.platform,
    osVersion: device.osVersion,
    model: device.model,
    clientVersion: device.clientVersion,
    linkedVia: device.linkedVia,
    linkedByDeviceId: device.linkedByDeviceId,
    createdAt: formatIso(device.createdAt),
    lastSeenAt: formatIso(device.lastSeenAt),
    lastSyncAt: formatIsoOrNull(device.lastSyncAt),
    recentUntil: formatIsoOrNull(recentUntil(policyDevice(device), clock)),
    isCurrent: device.id === currentDeviceId,
  };
}

/**
 * API §4.4 order of `DeviceListResponse.devices`: the current device first, the others by `lastSeenAt` descending;
 * ties by `id` so the order is deterministic.
 */
export function orderDevices<T extends Pick<DeviceRecord, "id" | "lastSeenAt">>(
  devices: readonly T[],
  currentDeviceId: string,
): T[] {
  return [...devices].sort((a, b) => {
    if (a.id === currentDeviceId || b.id === currentDeviceId) return a.id === currentDeviceId ? -1 : 1;
    if (a.lastSeenAt !== b.lastSeenAt) return b.lastSeenAt - a.lastSeenAt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
