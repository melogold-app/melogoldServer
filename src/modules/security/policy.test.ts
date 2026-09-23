/**
 * The matrix of DESIGN §4.8, row by row. The rows are read from `docs/DESIGN.md`: a new or renamed row fails the
 * coverage test until it gets its own test here.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { HOUR_MS } from "../../lib/clock.ts";
import {
  LINKED_VIA_LINK,
  RECOVERY_POLICY,
  approveLinkGate,
  changePasswordDecision,
  deleteAccountGate,
  isRecentDevice,
  needsPasswordFor,
  recentUntil,
  renameDeviceGate,
  revokeDeviceGate,
  revokeOthersGate,
  rotateRecoveryCodeGate,
} from "./policy.ts";
import type { PolicyClock, PolicyDevice } from "./policy.ts";

const T0 = Date.UTC(2026, 8, 23, 10, 0, 0);
const HOURS = 24;
const clockAt = (now: number): PolicyClock => ({ now, newDeviceRestrictHours: HOURS });
const NOW = clockAt(T0 + 2 * HOUR_MS);

let nextId = 0;
function device(linkedVia: string, createdAt: number): PolicyDevice {
  nextId += 1;
  return { id: `00000000-0000-4000-8000-${String(nextId).padStart(12, "0")}`, linkedVia, createdAt };
}

/** A device old enough never to be recent. */
const oldDevice = () => device("login", T0 - 30 * 24 * HOUR_MS);
/** A device created by login one hour ago: recent. */
const recentDevice = () => device("login", NOW.now - HOUR_MS);

const PASSWORD = "две собаки и кот";

describe("recent(d) (DESIGN §4.8 definition)", () => {
  test("register and recovery devices are never recent", () => {
    for (const via of ["register", "recovery"]) {
      assert.equal(isRecentDevice(device(via, NOW.now), NOW), false, via);
      assert.equal(recentUntil(device(via, NOW.now), NOW), null, via);
    }
  });

  test("login, link and unknown future values are recent for NEW_DEVICE_RESTRICT_HOURS", () => {
    for (const via of ["login", "link", "something_new"]) {
      const d = device(via, NOW.now - HOUR_MS);
      assert.equal(isRecentDevice(d, NOW), true, via);
      assert.equal(recentUntil(d, NOW), d.createdAt + HOURS * HOUR_MS, via);
    }
  });

  test("the window is half-open: recent until createdAt + 24 h, not at that instant", () => {
    const d = device("login", T0);
    const end = T0 + HOURS * HOUR_MS;
    assert.equal(isRecentDevice(d, clockAt(end - 1)), true);
    assert.equal(recentUntil(d, clockAt(end - 1)), end);
    assert.equal(isRecentDevice(d, clockAt(end)), false);
    assert.equal(recentUntil(d, clockAt(end)), null);
  });

  test("NEW_DEVICE_RESTRICT_HOURS = 0 disables the restriction", () => {
    const d = device("login", T0);
    assert.equal(isRecentDevice(d, { now: T0, newDeviceRestrictHours: 0 }), false);
  });
});

/** One test per row of the DESIGN §4.8 table, keyed by the text of its first column. */
const ROWS: ReadonlyMap<string, () => void> = new Map([
  [
    "Переименовать своё устройство",
    () => {
      // Always, even for a brand-new device and without a password.
      for (const me of [recentDevice(), oldDevice(), device("link", NOW.now)]) {
        assert.deepEqual(renameDeviceGate(me, me, undefined, NOW), { outcome: "allow" });
        assert.equal(needsPasswordFor(me, me, NOW), false);
      }
    },
  ],
  [
    "Переименовать или отозвать чужое устройство `t`",
    () => {
      const me = recentDevice();
      const older = oldDevice();
      const newer = device("login", me.createdAt + 1);
      const sameAge = device("login", me.createdAt);
      for (const gate of [renameDeviceGate, revokeDeviceGate]) {
        // recent(me) ∧ t.createdAt < me.createdAt: the password is required.
        assert.deepEqual(gate(me, older, undefined, NOW), { outcome: "refuse", code: "recent_device_restricted" });
        assert.deepEqual(gate(me, older, PASSWORD, NOW), { outcome: "verify_password", password: PASSWORD });
        // A target that is not older than me (newer or created in the same millisecond): no password.
        assert.deepEqual(gate(me, newer, undefined, NOW), { outcome: "allow" });
        assert.deepEqual(gate(me, sameAge, undefined, NOW), { outcome: "allow" });
        // me is not recent (old, or register/recovery): no password, and a given one is ignored.
        assert.deepEqual(gate(oldDevice(), older, undefined, NOW), { outcome: "allow" });
        assert.deepEqual(gate(device("register", NOW.now), older, PASSWORD, NOW), { outcome: "allow" });
        assert.deepEqual(gate(device("recovery", NOW.now), older, undefined, NOW), { outcome: "allow" });
        // After the window the same device is no longer restricted.
        assert.deepEqual(gate(me, older, undefined, clockAt(me.createdAt + HOURS * HOUR_MS)), { outcome: "allow" });
      }
      // Revoking the current device is not a revoke: 409, whatever the password (API §4.4: use logout).
      assert.deepEqual(revokeDeviceGate(me, me, PASSWORD, NOW), {
        outcome: "refuse",
        code: "cannot_revoke_current_device",
      });
      assert.deepEqual(revokeDeviceGate(oldDevice(), older, undefined, NOW), { outcome: "allow" });
    },
  ],
  [
    "`revoke-others`",
    () => {
      const me = recentDevice();
      const newer = device("login", me.createdAt + 1);
      const older = oldDevice();
      // Only newer targets: nothing restricted.
      assert.deepEqual(revokeOthersGate(me, [newer], undefined, NOW), { outcome: "allow" });
      // One restricted target refuses the whole call: no device is removed.
      assert.deepEqual(revokeOthersGate(me, [newer, older], undefined, NOW), {
        outcome: "refuse",
        code: "recent_device_restricted",
      });
      // With the password, the whole call depends on one verification.
      assert.deepEqual(revokeOthersGate(me, [newer, older], PASSWORD, NOW), {
        outcome: "verify_password",
        password: PASSWORD,
      });
      // A device that is not recent revokes everything without a password.
      assert.deepEqual(revokeOthersGate(oldDevice(), [older, newer, me], undefined, NOW), { outcome: "allow" });
      // No targets at all.
      assert.deepEqual(revokeOthersGate(me, [], undefined, NOW), { outcome: "allow" });
      // The current device in the list never counts as a target.
      assert.deepEqual(revokeOthersGate(me, [me], undefined, NOW), { outcome: "allow" });
    },
  ],
  [
    "Смена пароля со старым",
    () => {
      // Any signed-in device: there is no device input at all; the old password is verified (wrong → 403).
      assert.deepEqual(changePasswordDecision(PASSWORD), {
        gate: { outcome: "verify_password", password: PASSWORD },
        notifyReason: "password_changed",
      });
    },
  ],
  [
    "Смена пароля без старого",
    () => {
      // Owner decision 2026-09-23: allowed from any signed-in device, recent included; the others are told.
      assert.deepEqual(changePasswordDecision(undefined), {
        gate: { outcome: "allow" },
        notifyReason: "password_changed_without_old",
      });
    },
  ],
  [
    "Новый код восстановления",
    () => {
      assert.deepEqual(rotateRecoveryCodeGate(PASSWORD), { outcome: "verify_password", password: PASSWORD });
    },
  ],
  [
    "Удаление аккаунта",
    () => {
      assert.deepEqual(deleteAccountGate(PASSWORD), { outcome: "verify_password", password: PASSWORD });
    },
  ],
  [
    "Одобрение привязки",
    () => {
      // Any signed-in device approves, recent or not ...
      assert.deepEqual(approveLinkGate(), { outcome: "allow" });
      // ... and the device the link creates is recent for 24 h.
      const created = device(LINKED_VIA_LINK, NOW.now);
      assert.equal(isRecentDevice(created, NOW), true);
      assert.equal(recentUntil(created, NOW), NOW.now + HOURS * HOUR_MS);
      assert.equal(isRecentDevice(created, clockAt(NOW.now + HOURS * HOUR_MS)), false);
    },
  ],
  [
    "Восстановление кодом",
    () => {
      assert.equal(RECOVERY_POLICY.credential, "recovery_code");
      assert.equal(RECOVERY_POLICY.removesAllDevices, true);
      // The new device is created with linked_via = recovery and is never restricted.
      const created = device(RECOVERY_POLICY.newDeviceLinkedVia, NOW.now);
      assert.equal(isRecentDevice(created, NOW), false);
      assert.deepEqual(renameDeviceGate(created, oldDevice(), undefined, NOW), { outcome: "allow" });
    },
  ],
]);

function matrixRowsFromDesign(): string[] {
  const design = readFileSync(new URL("../../../docs/DESIGN.md", import.meta.url), "utf8");
  const from = design.indexOf("### 4.8");
  const to = design.indexOf("### 4.9", from);
  assert.ok(from >= 0 && to > from, "DESIGN §4.8 not found");
  return design
    .slice(from, to)
    .split("\n")
    .filter((line) => line.startsWith("|") && !/^\|\s*-/.test(line))
    .slice(1) // header
    .map((line) => (line.split("|")[1] ?? "").trim());
}

describe("DESIGN §4.8 matrix", () => {
  test("every row of the table has a test", () => {
    assert.deepEqual(matrixRowsFromDesign(), [...ROWS.keys()]);
  });

  for (const [row, check] of ROWS) test(row, check);
});
