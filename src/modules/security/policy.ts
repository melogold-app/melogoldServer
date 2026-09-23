/**
 * The matrix of sensitive actions (DESIGN §4.8) as pure functions. Frozen after M0 (PLAN, general rules item 2).
 *
 * **Owner decision (2026-09-23):** the password can be changed from any signed-in device, also without the old
 * password; there is no cooldown and no device-age threshold. The other devices learn about it from
 * `account.updated{password_changed_without_old}`.
 *
 * **`recent(d)`:** `d.linkedVia ∉ {register, recovery}` and `now < d.createdAt + NEW_DEVICE_RESTRICT_HOURS`. It
 * applies to **every** new device, including one created by login or by a device link.
 *
 * | Action                                   | Allowed             | Restriction                                                    |
 * | ---------------------------------------- | ------------------- | -------------------------------------------------------------- |
 * | rename own device                        | always              | —                                                              |
 * | rename or revoke another device `t`      | signed-in device    | `recent(me) ∧ t.createdAt < me.createdAt` needs the password  |
 * | revoke-others                            | same, per target    | a 403 for any target removes no device                         |
 * | change password with the old one         | any signed-in       | wrong old password → `403 invalid_password`                    |
 * | change password without the old one      | any signed-in       | the others get `account.updated{password_changed_without_old}` |
 * | new recovery code                        | password            | —                                                              |
 * | delete account                           | password            | —                                                              |
 * | approve a device link                    | signed-in device    | the new device is `recent` for 24 h                            |
 * | recover with the code                    | recovery code       | removes every device                                           |
 *
 * Each function returns a {@link Gate}; the service then either proceeds, verifies the password (argon2 outside the
 * transaction, reauth throttling: wrong → `403 invalid_password`, 5 failures → `429 reauth_throttled`), or refuses
 * with the code. A password that is not required is ignored (never verified).
 */
import type { LinkedVia } from "../../contract/common.ts";
import type { AccountUpdatedReason } from "../../contract/live.ts";
import { HOUR_MS } from "../../lib/clock.ts";

/** The device fields the matrix reads. `linkedVia` is a string: unknown future values count as restrictable. */
export type PolicyDevice = Readonly<{ id: string; linkedVia: string; createdAt: number }>;

/** `now` and `NEW_DEVICE_RESTRICT_HOURS` (API §10). */
export type PolicyClock = Readonly<{ now: number; newDeviceRestrictHours: number }>;

/** Refusal codes of the matrix (API §2.2). */
export type GateRefusal = "recent_device_restricted" | "cannot_revoke_current_device";

export type Gate =
  | Readonly<{ outcome: "allow" }>
  /** Verify `password` (reauth): wrong → `403 invalid_password`. */
  | Readonly<{ outcome: "verify_password"; password: string }>
  | Readonly<{ outcome: "refuse"; code: GateRefusal }>;

const ALLOW: Gate = Object.freeze({ outcome: "allow" });

function verify(password: string): Gate {
  return Object.freeze({ outcome: "verify_password", password });
}

function refuse(code: GateRefusal): Gate {
  return Object.freeze({ outcome: "refuse", code });
}

/** `linked_via` values that never make a device `recent`: the account holder proved the password or the code. */
export const NEVER_RECENT_LINKED_VIA: readonly LinkedVia[] = Object.freeze(["register", "recovery"]);

/** How a device made by approving a link is created (DESIGN §4.10.6): it is `recent`. */
export const LINKED_VIA_LINK: LinkedVia = "link";
/** How the device of `/auth/recover` is created (DESIGN §4.9): it is not `recent`. */
export const LINKED_VIA_RECOVERY: LinkedVia = "recovery";

function restrictEndsAt(device: PolicyDevice, clock: PolicyClock): number {
  return device.createdAt + clock.newDeviceRestrictHours * HOUR_MS;
}

function exempt(device: PolicyDevice): boolean {
  return (NEVER_RECENT_LINKED_VIA as readonly string[]).includes(device.linkedVia);
}

/** `recent(d)` of DESIGN §4.8. */
export function isRecentDevice(device: PolicyDevice, clock: PolicyClock): boolean {
  return !exempt(device) && clock.now < restrictEndsAt(device, clock);
}

/** `DeviceDto.recentUntil` (API §4.1): the end of the restriction while the device is recent, otherwise `null`. */
export function recentUntil(device: PolicyDevice, clock: PolicyClock): number | null {
  return isRecentDevice(device, clock) ? restrictEndsAt(device, clock) : null;
}

/** Whether `me` needs the password to act on `target` (row "rename or revoke another device"). */
export function needsPasswordFor(me: PolicyDevice, target: PolicyDevice, clock: PolicyClock): boolean {
  return target.id !== me.id && isRecentDevice(me, clock) && target.createdAt < me.createdAt;
}

function passwordGate(required: boolean, password: string | undefined): Gate {
  if (!required) return ALLOW;
  return password === undefined ? refuse("recent_device_restricted") : verify(password);
}

/**
 * `PATCH /auth/me/devices/{deviceId}` (rows "rename own device" and "rename another device").
 * @param password the optional `password` of the request.
 */
export function renameDeviceGate(
  me: PolicyDevice,
  target: PolicyDevice,
  password: string | undefined,
  clock: PolicyClock,
): Gate {
  return passwordGate(needsPasswordFor(me, target, clock), password);
}

/** `POST /auth/me/devices/{deviceId}/revoke` (row "revoke another device"; the own device → use logout). */
export function revokeDeviceGate(
  me: PolicyDevice,
  target: PolicyDevice,
  password: string | undefined,
  clock: PolicyClock,
): Gate {
  if (target.id === me.id) return refuse("cannot_revoke_current_device");
  return passwordGate(needsPasswordFor(me, target, clock), password);
}

/**
 * `POST /auth/me/devices/revoke-others` (row "revoke-others"): one gate for all targets, so a refusal or a wrong
 * password removes no device. The current device among `targets` is ignored.
 */
export function revokeOthersGate(
  me: PolicyDevice,
  targets: readonly PolicyDevice[],
  password: string | undefined,
  clock: PolicyClock,
): Gate {
  return passwordGate(
    targets.some((target) => needsPasswordFor(me, target, clock)),
    password,
  );
}

export type ChangePasswordDecision = Readonly<{
  gate: Gate;
  /** `account.updated` reason for the other devices (API §6). */
  notifyReason: Extract<AccountUpdatedReason, "password_changed" | "password_changed_without_old">;
}>;

/**
 * `POST /auth/me/password` (rows "change password with / without the old one"): allowed from any signed-in device,
 * recent or not.
 */
export function changePasswordDecision(currentPassword: string | undefined): ChangePasswordDecision {
  return currentPassword === undefined
    ? Object.freeze({ gate: ALLOW, notifyReason: "password_changed_without_old" })
    : Object.freeze({ gate: verify(currentPassword), notifyReason: "password_changed" });
}

/** `POST /auth/me/recovery-code` (row "new recovery code"): always the password. */
export function rotateRecoveryCodeGate(password: string): Gate {
  return verify(password);
}

/** `POST /auth/me/delete` (row "delete account"): always the password. */
export function deleteAccountGate(password: string): Gate {
  return verify(password);
}

/**
 * `POST /auth/me/links/{linkId}/approve` (row "approve a device link"): any signed-in device, recent or not. The
 * device the link creates gets `linked_via = "link"` and so is recent ({@link LINKED_VIA_LINK}).
 */
export function approveLinkGate(): Gate {
  return ALLOW;
}

/**
 * `POST /auth/recover` (row "recover with the code"): the recovery code is the only credential; every device of the
 * account is removed and the new one gets `linked_via = "recovery"` (not recent).
 */
export const RECOVERY_POLICY = Object.freeze({
  credential: "recovery_code",
  removesAllDevices: true,
  newDeviceLinkedVia: LINKED_VIA_RECOVERY,
} as const);
