/**
 * Rows → DTOs of API §4.1 for the answers of this module (`AuthSession`, `RefreshResponse`, `MeResponse`).
 */
import type { AuthSession, DeviceDto, UserDto } from "../../contract/common.ts";
import type { IssuedSession } from "../../lib/session.ts";
import { formatIso, formatIsoOrNull } from "../../lib/time.ts";
import { recentUntil } from "../security/policy.ts";
import type { DeviceRow, UserRow } from "./auth.repository.ts";

export function toUserDto(user: UserRow): UserDto {
  return {
    id: user.id,
    login: user.login,
    createdAt: formatIso(user.created_at),
    passwordChangedAt: formatIso(user.password_changed_at),
    recoveryCodeStatus: {
      createdAt: formatIso(user.recovery_code_created_at),
      confirmed: user.recovery_code_confirmed_at !== null,
    },
  };
}

export type DeviceDtoContext = Readonly<{
  /** The device of the request (`isCurrent`). */
  currentDeviceId: string;
  now: number;
  /** `NEW_DEVICE_RESTRICT_HOURS`. */
  newDeviceRestrictHours: number;
}>;

export function toDeviceDto(device: DeviceRow, context: DeviceDtoContext): DeviceDto {
  const until = recentUntil(
    { id: device.id, linkedVia: device.linked_via, createdAt: device.created_at },
    { now: context.now, newDeviceRestrictHours: context.newDeviceRestrictHours },
  );
  return {
    id: device.id,
    name: device.custom_name ?? device.reported_name,
    reportedName: device.reported_name,
    customName: device.custom_name,
    platform: device.platform,
    osVersion: device.os_version,
    model: device.model,
    clientVersion: device.client_version,
    linkedVia: device.linked_via,
    linkedByDeviceId: device.linked_by_device_id,
    createdAt: formatIso(device.created_at),
    lastSeenAt: formatIso(device.last_seen_at),
    lastSyncAt: formatIsoOrNull(device.last_sync_at),
    recentUntil: formatIsoOrNull(until),
    isCurrent: device.id === context.currentDeviceId,
  };
}

export type AuthSessionParts = Readonly<{
  user: UserRow;
  device: DeviceRow;
  session: IssuedSession;
  serverId: string;
  now: number;
  newDeviceRestrictHours: number;
  /** register and recover: the new code (`XXXX-XXXX-XXXX-XXXX-XXXX`); otherwise `null`. */
  recoveryCode?: string | null;
  /** recover: how many devices were removed; otherwise 0. */
  signedOutDevices?: number;
}>;

/** API §4.1 `AuthSession` (register, login, recover, completed device link). */
export function toAuthSession(parts: AuthSessionParts): AuthSession {
  return {
    user: toUserDto(parts.user),
    device: toDeviceDto(parts.device, {
      currentDeviceId: parts.device.id,
      now: parts.now,
      newDeviceRestrictHours: parts.newDeviceRestrictHours,
    }),
    tokens: { ...parts.session.tokens },
    serverId: parts.serverId,
    serverTime: formatIso(parts.now),
    recoveryCode: parts.recoveryCode ?? null,
    signedOutDevices: parts.signedOutDevices ?? 0,
  };
}
