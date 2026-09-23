/** `DeviceDto` (API §4.1) and the order of `DeviceListResponse.devices` (API §4.4). */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DeviceDto } from "../../contract/common.ts";
import { HOUR_MS } from "../../lib/clock.ts";
import { orderDevices, policyClock, toDeviceDto } from "./device-dto.ts";
import type { DeviceRecord } from "./device-dto.ts";

const T0 = Date.UTC(2026, 8, 23, 10, 0, 0);
const CLOCK = policyClock(T0 + HOUR_MS, 24);

function record(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    id: "9b1e2f4a-7c3d-4e5f-8a9b-0c1d2e3f4a5b",
    reportedName: "Google Pixel 8",
    customName: null,
    platform: "android",
    osVersion: "16",
    model: "Google Pixel 8",
    clientVersion: "1.3.0",
    linkedVia: "register",
    linkedByDeviceId: null,
    createdAt: T0,
    lastSeenAt: T0 + 5 * 60_000,
    lastSyncAt: T0 + 4 * 60_000,
    ...overrides,
  };
}

describe("toDeviceDto", () => {
  test("the API §4.4 example", () => {
    const dto = toDeviceDto(record(), "9b1e2f4a-7c3d-4e5f-8a9b-0c1d2e3f4a5b", CLOCK);
    assert.deepEqual(dto, {
      id: "9b1e2f4a-7c3d-4e5f-8a9b-0c1d2e3f4a5b",
      name: "Google Pixel 8",
      reportedName: "Google Pixel 8",
      customName: null,
      platform: "android",
      osVersion: "16",
      model: "Google Pixel 8",
      clientVersion: "1.3.0",
      linkedVia: "register",
      linkedByDeviceId: null,
      createdAt: "2026-09-23T10:00:00.000Z",
      lastSeenAt: "2026-09-23T10:05:00.000Z",
      lastSyncAt: "2026-09-23T10:04:00.000Z",
      recentUntil: null,
      isCurrent: true,
    });
    // Every key of the component, in its order (API §1.3: every declared field is present).
    assert.deepEqual(Object.keys(dto), Object.keys(DeviceDto.shape));
    assert.ok(DeviceDto.safeParse(dto).success);
  });

  test("name is customName ?? reportedName; lastSyncAt null; another device is not current", () => {
    const dto = toDeviceDto(record({ customName: "Рабочий", lastSyncAt: null }), "other", CLOCK);
    assert.equal(dto.name, "Рабочий");
    assert.equal(dto.reportedName, "Google Pixel 8");
    assert.equal(dto.lastSyncAt, null);
    assert.equal(dto.isCurrent, false);
  });

  test("recentUntil: createdAt + NEW_DEVICE_RESTRICT_HOURS while recent (DESIGN §4.8), else null", () => {
    const linked = record({ linkedVia: "link", linkedByDeviceId: "77b2c1d0-3e4f-4a5b-8c6d-7e8f9a0b1c2d" });
    assert.equal(toDeviceDto(linked, "x", CLOCK).recentUntil, "2026-09-24T10:00:00.000Z");
    assert.equal(toDeviceDto(record({ linkedVia: "login" }), "x", CLOCK).recentUntil, "2026-09-24T10:00:00.000Z");
    assert.equal(toDeviceDto(record({ linkedVia: "recovery" }), "x", CLOCK).recentUntil, null);
    assert.equal(
      toDeviceDto(record({ linkedVia: "login" }), "x", policyClock(T0 + 24 * HOUR_MS, 24)).recentUntil,
      null,
    );
  });
});

describe("orderDevices", () => {
  test("the current device first, then lastSeenAt descending, ties by id", () => {
    const devices = [
      { id: "b", lastSeenAt: 5 },
      { id: "cur", lastSeenAt: 1 },
      { id: "a", lastSeenAt: 5 },
      { id: "c", lastSeenAt: 9 },
      { id: "d", lastSeenAt: 2 },
    ];
    assert.deepEqual(
      orderDevices(devices, "cur").map((device) => device.id),
      ["cur", "c", "a", "b", "d"],
    );
    assert.deepEqual(
      orderDevices(devices, "missing").map((device) => device.id),
      ["c", "a", "b", "d", "cur"],
    );
  });
});
