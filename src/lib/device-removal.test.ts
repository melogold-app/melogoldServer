/** `afterRemove`: live effects of a committed removal, in the order of DESIGN §4.6 (API §5, §6). */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { REMOVAL_EFFECTS, afterRemove, deviceRemovalEffects } from "./device-removal.ts";
import type { LiveTarget, RemovalLive, RemovalReason } from "./device-removal.ts";

type Call =
  | { kind: "publish"; userId: string; type: string; payload: object; target: LiveTarget | undefined }
  | { kind: "closeDevice"; userId: string; deviceId: string }
  | { kind: "closeUser"; userId: string };

function recorder(): { live: RemovalLive; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    live: {
      publish: (userId, type, payload, target) => {
        calls.push({ kind: "publish", userId, type, payload, target });
      },
      closeDevice: (userId, deviceId) => {
        calls.push({ kind: "closeDevice", userId, deviceId });
      },
      closeUser: (userId) => {
        calls.push({ kind: "closeUser", userId });
      },
    },
  };
}

const U = "u";

describe("afterRemove", () => {
  test("revoke: session.invalidated to the device, close it, then devices.updated to everyone left", () => {
    const { live, calls } = recorder();
    afterRemove(live, { userId: U, deviceIds: ["d1"], reason: "device_revoked" });
    assert.deepEqual(calls, [
      {
        kind: "publish",
        userId: U,
        type: "session.invalidated",
        payload: { reason: "device_revoked", forceRelogin: true },
        target: { onlyDeviceId: "d1" },
      },
      { kind: "closeDevice", userId: U, deviceId: "d1" },
      {
        kind: "publish",
        userId: U,
        type: "devices.updated",
        payload: { reason: "device_removed", deviceId: "d1" },
        target: undefined,
      },
    ]);
  });

  test("several devices: one invalidation and close each, one devices.updated with deviceId null", () => {
    const { live, calls } = recorder();
    afterRemove(live, { userId: U, deviceIds: ["d1", "d2"], reason: "password_changed" });
    assert.deepEqual(
      calls.map((call) => (call.kind === "publish" ? `${call.type}:${JSON.stringify(call.payload)}` : call.kind)),
      [
        'session.invalidated:{"reason":"password_changed","forceRelogin":true}',
        "closeDevice",
        'session.invalidated:{"reason":"password_changed","forceRelogin":true}',
        "closeDevice",
        'devices.updated:{"reason":"device_removed","deviceId":null}',
      ],
    );
  });

  test("logout: no invalidation, device_signed_out to the others", () => {
    const { live, calls } = recorder();
    afterRemove(live, { userId: U, deviceIds: ["d1"], reason: "device_signed_out" });
    assert.deepEqual(
      calls.map((call) => call.kind + (call.kind === "publish" ? `:${call.type}` : "")),
      ["closeDevice", "publish:devices.updated"],
    );
    assert.deepEqual(calls[1]?.kind === "publish" ? calls[1].payload : null, {
      reason: "device_signed_out",
      deviceId: "d1",
    });
  });

  test("account deletion closes the user; recovery and account deletion send no devices.updated", () => {
    const deleted = recorder();
    afterRemove(deleted.live, { userId: U, deviceIds: ["d1"], reason: "account_deleted" });
    assert.deepEqual(
      deleted.calls.map((call) => call.kind + (call.kind === "publish" ? `:${call.type}` : "")),
      ["publish:session.invalidated", "closeDevice", "closeUser"],
    );
    const recovered = recorder();
    afterRemove(recovered.live, { userId: U, deviceIds: ["d1", "d2"], reason: "recovery_reset" });
    assert.ok(recovered.calls.every((call) => call.kind !== "publish" || call.type === "session.invalidated"));
  });

  test("inactive cleanup (background job) publishes nothing, only closes streams", () => {
    const { live, calls } = recorder();
    afterRemove(live, { userId: U, deviceIds: ["d1"], reason: "inactive" });
    assert.deepEqual(calls, [{ kind: "closeDevice", userId: U, deviceId: "d1" }]);
  });

  test("nothing removed, nothing published", () => {
    const { live, calls } = recorder();
    afterRemove(live, { userId: U, deviceIds: [], reason: "device_revoked" });
    assert.deepEqual(calls, []);
  });

  test("every reason's session.invalidated value is one of API §6", () => {
    const allowed = new Set(["device_revoked", "password_changed", "recovery_reset", "token_reuse", "account_deleted"]);
    for (const [reason, effects] of Object.entries(REMOVAL_EFFECTS) as [
      RemovalReason,
      (typeof REMOVAL_EFFECTS)[RemovalReason],
    ][]) {
      if (effects.invalidated !== null) assert.ok(allowed.has(effects.invalidated), reason);
    }
  });

  test("hub errors are reported, not thrown, and do not stop the remaining effects", () => {
    const errors: unknown[] = [];
    const { live, calls } = recorder();
    const failing: RemovalLive = {
      ...live,
      publish: (...args) => {
        live.publish(...args);
        throw new Error("hub down");
      },
    };
    const effects = deviceRemovalEffects(failing, { onError: (error) => errors.push(error) });
    effects.afterRemove({ userId: U, deviceIds: ["d1"], reason: "token_reuse" });
    assert.equal(errors.length, 2);
    assert.deepEqual(
      calls.map((call) => call.kind),
      ["publish", "closeDevice", "publish"],
    );
  });
});
