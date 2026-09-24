/**
 * The devices of the account (API §4.4, T1.2): list, rename, revoke one, revoke the others. The 403 rules are the
 * DESIGN §4.8 matrix (`src/modules/security/policy.ts`), enforced by `reauth.ts`.
 *
 * Every password-gated action runs in three steps (argon2 never inside a transaction, docs/database.md §2.3):
 * 1. read the caller and the targets in `db.read`, compute the gate: refuse, or verify the password (reauth);
 * 2. in `db.write`, read them again and re-check the gate on what the transaction sees, then write;
 * 3. after commit, the live effects: `devices.updated{device_renamed}` for a rename; `ctx.devices.afterRemove` for
 *    a removal (`session.invalidated{device_revoked}` → streams closed → `devices.updated{device_removed}`).
 *
 * Removing a device is revoking its session: only through `removeDevicesInTx` (DESIGN §4.6), which also cancels the
 * unfinished links it approves; its refresh tokens go by `ON DELETE CASCADE`.
 */
import type { AppContext } from "../../context.ts";
import type { DeviceDto } from "../../contract/common.ts";
import type { DeviceListResponse, RevokeOthersResponse } from "../../contract/devices.ts";
import { lockUser } from "../../db/heads.ts";
import type { Queryable } from "../../db/index.ts";
import type { RequestAuth } from "../../http/auth-guard.ts";
import { AppError } from "../../http/errors.ts";
import { removeDevicesInTx } from "../../lib/device-removal.ts";
import { renameDeviceGate, revokeDeviceGate, revokeOthersGate } from "../security/policy.ts";
import type { Gate, PolicyClock } from "../security/policy.ts";
import { orderDevices, policyClock, policyDevice, toDeviceDto } from "./device-dto.ts";
import type { DeviceRecord } from "./device-dto.ts";
import { findUserDevices, listUserDevices, setCustomName } from "./devices.repository.ts";
import { passGate, recheckGate } from "./reauth.ts";

export type DevicesContext = Pick<AppContext, "db" | "clock" | "env" | "log" | "live" | "devices">;

/** The caller of a Bearer route (`requireAuth(request)`). */
export type DevicesCaller = Pick<RequestAuth, "userId" | "deviceId">;

function clockOf(ctx: DevicesContext): PolicyClock {
  return policyClock(ctx.clock.now(), ctx.env.NEW_DEVICE_RESTRICT_HOURS);
}

type Pair = Readonly<{ me: DeviceRecord; target: DeviceRecord }>;

/**
 * The caller's device and the target. The caller's device vanished (revoked in parallel) → `401 session_revoked`;
 * the target is unknown or belongs to another user → `404 device_not_found`.
 */
async function readPair(q: Queryable, caller: DevicesCaller, targetId: string): Promise<Pair> {
  const rows = await findUserDevices(q, caller.userId, [caller.deviceId, targetId]);
  const me = rows.find((row) => row.id === caller.deviceId);
  if (!me) throw new AppError("session_revoked");
  const target = rows.find((row) => row.id === targetId);
  if (!target) throw new AppError("device_not_found");
  return { me, target };
}

type Others = Readonly<{ me: DeviceRecord; others: readonly DeviceRecord[] }>;

async function readOthers(q: Queryable, caller: DevicesCaller): Promise<Others> {
  const devices = await listUserDevices(q, caller.userId);
  const me = devices.find((device) => device.id === caller.deviceId);
  if (!me) throw new AppError("session_revoked");
  return { me, others: devices.filter((device) => device.id !== caller.deviceId) };
}

/** `GET /auth/me/devices`: the current device first, the others by `lastSeenAt` descending. */
export async function listDevices(ctx: DevicesContext, caller: DevicesCaller): Promise<DeviceListResponse> {
  const devices = await ctx.db.read((q) => listUserDevices(q, caller.userId));
  if (!devices.some((device) => device.id === caller.deviceId)) throw new AppError("session_revoked");
  const clock = clockOf(ctx);
  return {
    devices: orderDevices(devices, caller.deviceId).map((device) => toDeviceDto(device, caller.deviceId, clock)),
    maxDevices: ctx.env.MAX_DEVICES_PER_USER,
  };
}

export type RenameInput = Readonly<{
  deviceId: string;
  /** Cleaned `DeviceName`; `null` returns to the reported name. */
  name: string | null;
  password: string | undefined;
}>;

/**
 * `PATCH /auth/me/devices/{deviceId}`: the own device always; another one needs the password when the caller is
 * recent and the target older (DESIGN §4.8). `devices.updated{device_renamed}` goes to every device of the user when
 * the name changed.
 */
export async function renameDevice(ctx: DevicesContext, caller: DevicesCaller, input: RenameInput): Promise<DeviceDto> {
  const gate = (pair: Pair): Gate =>
    renameDeviceGate(policyDevice(pair.me), policyDevice(pair.target), input.password, clockOf(ctx));

  const before = await ctx.db.read((q) => readPair(q, caller, input.deviceId));
  const verified = await passGate(ctx, caller.userId, gate(before));
  const result = await ctx.db.write(async (q) => {
    const pair = await readPair(q, caller, input.deviceId);
    recheckGate(gate(pair), verified);
    const updated = await setCustomName(q, caller.userId, input.deviceId, input.name);
    if (!updated) throw new AppError("device_not_found");
    return { updated, changed: pair.target.customName !== input.name };
  });
  if (result.changed) {
    ctx.live.publish(caller.userId, "devices.updated", { reason: "device_renamed", deviceId: input.deviceId });
  }
  return toDeviceDto(result.updated, caller.deviceId, clockOf(ctx));
}

/**
 * `POST /auth/me/devices/{deviceId}/revoke`: the own device → `409 cannot_revoke_current_device` (logout is the way);
 * another one → removed, with the password when the caller is recent and the target older (DESIGN §4.8).
 */
export async function revokeDevice(
  ctx: DevicesContext,
  caller: DevicesCaller,
  input: Readonly<{ deviceId: string; password: string | undefined }>,
): Promise<void> {
  const gate = (pair: Pair): Gate =>
    revokeDeviceGate(policyDevice(pair.me), policyDevice(pair.target), input.password, clockOf(ctx));

  const before = await ctx.db.read((q) => readPair(q, caller, input.deviceId));
  const verified = await passGate(ctx, caller.userId, gate(before));
  const removed = await ctx.db.write(async (q) => {
    recheckGate(gate(await readPair(q, caller, input.deviceId)), verified);
    const result = await removeDevicesInTx(q, caller.userId, [input.deviceId], "device_revoked");
    if (result.deviceIds.length === 0) throw new AppError("device_not_found");
    return result;
  });
  ctx.devices.afterRemove(removed);
}

/**
 * `POST /auth/me/devices/revoke-others`: one gate for every other device, so a refusal or a wrong password removes
 * nothing (DESIGN §4.8). The write holds `lockUser` (docs/database.md §2.5), so no device appears or goes between the
 * check and the removal.
 */
export async function revokeOtherDevices(
  ctx: DevicesContext,
  caller: DevicesCaller,
  input: Readonly<{ password: string | undefined }>,
): Promise<RevokeOthersResponse> {
  const gate = (state: Others): Gate =>
    revokeOthersGate(policyDevice(state.me), state.others.map(policyDevice), input.password, clockOf(ctx));

  const before = await ctx.db.read((q) => readOthers(q, caller));
  const verified = await passGate(ctx, caller.userId, gate(before));
  const removed = await ctx.db.write(async (q) => {
    await lockUser(q, caller.userId);
    const state = await readOthers(q, caller);
    recheckGate(gate(state), verified);
    return removeDevicesInTx(
      q,
      caller.userId,
      state.others.map((device) => device.id),
      "device_revoked",
    );
  });
  ctx.devices.afterRemove(removed);
  return { revokedCount: removed.deviceIds.length };
}
