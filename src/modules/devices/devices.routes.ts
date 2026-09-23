/**
 * Routes of the `devices` module (API §4.4, T1.2): list, rename, revoke one, revoke the others. The 403 rules are the
 * matrix of DESIGN §4.8 (`src/modules/security/policy.ts`).
 *
 * M0: development stubs with their complete schemas (PLAN step 0.8); every handler answers `501 not_implemented`.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { AppContext } from "../../context.ts";
import { DeviceDto } from "../../contract/common.ts";
import {
  DeviceIdParams,
  DeviceListResponse,
  RenameDeviceRequest,
  RevokeDeviceRequest,
  RevokeOthersRequest,
  RevokeOthersResponse,
} from "../../contract/devices.ts";
import { notImplemented, operation } from "../../http/operation.ts";

export function registerDevicesRoutes(app: FastifyInstance, _ctx: AppContext): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.get(
    "/auth/me/devices",
    {
      schema: operation("GET", "/auth/me/devices", {
        operationId: "listDevices",
        tag: "devices",
        summary: "The devices of the account",
        description: "The current device first, the others by lastSeenAt descending (API §4.4).",
        status: 200,
        response: DeviceListResponse,
      }),
    },
    notImplemented,
  );

  routes.patch(
    "/auth/me/devices/:deviceId",
    {
      schema: operation("PATCH", "/auth/me/devices/:deviceId", {
        operationId: "renameDevice",
        tag: "devices",
        summary: "Rename a device",
        description:
          "`name: null` returns to the reported name. A recently added device must send `password` to rename " +
          "another device (DESIGN §4.8).",
        params: DeviceIdParams,
        body: RenameDeviceRequest,
        status: 200,
        response: DeviceDto,
        errors: ["invalid_password", "recent_device_restricted", "device_not_found", "reauth_throttled"],
      }),
    },
    notImplemented,
  );

  routes.post(
    "/auth/me/devices/:deviceId/revoke",
    {
      schema: operation("POST", "/auth/me/devices/:deviceId/revoke", {
        operationId: "revokeDevice",
        tag: "devices",
        summary: "Revoke another device",
        description:
          "After commit: session.invalidated{device_revoked} to that device, its streams close, devices.updated" +
          "{device_removed} to the others (API §4.4). Not retried automatically.",
        params: DeviceIdParams,
        body: RevokeDeviceRequest,
        status: 204,
        errors: [
          "invalid_password",
          "recent_device_restricted",
          "device_not_found",
          "cannot_revoke_current_device",
          "reauth_throttled",
        ],
      }),
    },
    notImplemented,
  );

  routes.post(
    "/auth/me/devices/revoke-others",
    {
      schema: operation("POST", "/auth/me/devices/revoke-others", {
        operationId: "revokeOtherDevices",
        tag: "devices",
        summary: "Sign out every other device",
        description: "The same rules for every target; on 403 no device is removed (API §4.4).",
        body: RevokeOthersRequest,
        status: 200,
        response: RevokeOthersResponse,
        errors: ["invalid_password", "recent_device_restricted", "reauth_throttled"],
      }),
    },
    notImplemented,
  );
}
