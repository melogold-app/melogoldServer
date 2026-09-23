/**
 * API §4.4: devices. The 403 rules (`recent_device_restricted`, `invalid_password`) are the matrix of DESIGN §4.8 in
 * `src/modules/security/policy.ts`.
 */
import { z } from "zod";
import { CheckedPassword, DeviceDto, DeviceName, Int32Out, IntOut, optional, Uuid } from "./common.ts";

/** Path parameters of `/auth/me/devices/{deviceId}…` (API §3: a malformed id → `400 invalid_request`). */
export const DeviceIdParams = z.object({ deviceId: Uuid });

export const DeviceListResponse = z
  .object({
    devices: z.array(DeviceDto).meta({ description: "The current device first, the others by lastSeenAt descending." }),
    maxDevices: Int32Out.nullable().meta({ description: "`null`: no limit." }),
  })
  .meta({ id: "DeviceListResponse" });

export const RenameDeviceRequest = z
  .object({
    name: DeviceName.nullable().meta({ description: "`null` returns to the reported name." }),
    password: optional(CheckedPassword),
  })
  .meta({ id: "RenameDeviceRequest" });

export const RevokeDeviceRequest = z
  .object({ password: optional(CheckedPassword) })
  .meta({ id: "RevokeDeviceRequest" });

export const RevokeOthersRequest = z
  .object({ password: optional(CheckedPassword) })
  .meta({ id: "RevokeOthersRequest" });

export const RevokeOthersResponse = z.object({ revokedCount: IntOut }).meta({ id: "RevokeOthersResponse" });

export type DeviceIdParams = z.output<typeof DeviceIdParams>;
export type DeviceListResponse = z.output<typeof DeviceListResponse>;
export type RenameDeviceRequest = z.output<typeof RenameDeviceRequest>;
export type RevokeDeviceRequest = z.output<typeof RevokeDeviceRequest>;
export type RevokeOthersRequest = z.output<typeof RevokeOthersRequest>;
export type RevokeOthersResponse = z.output<typeof RevokeOthersResponse>;
