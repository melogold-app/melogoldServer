/**
 * Pure parts of the linking service (API §1.6, §4.6; DESIGN §4.10): codes, the three verify choices, the computed
 * status, the network hint and the DTOs of the session a completed link returns.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DeviceDto, normalizeCrockfordCode, UserDto, USER_CODE_LENGTH } from "../../contract/common.ts";
import { HOUR_MS } from "../../lib/clock.ts";
import { newId } from "../../lib/ids.ts";
import {
  deviceDto,
  effectiveStatus,
  newUserCode,
  newVerifyCode,
  sameNetwork,
  userDto,
  verifyChoices,
  verifyChoicesKey,
} from "./linking.service.ts";
import type { DeviceRow, LinkRow } from "./linking.repository.ts";

const NOW = Date.UTC(2026, 8, 23, 10, 0, 0);
const KEY = verifyChoicesKey(Buffer.alloc(32, 2));

describe("codes (API §1.6)", () => {
  test("userCode: 8 Crockford characters that survive the input normalization", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 500; index += 1) {
      const code = newUserCode();
      assert.match(code, /^[0-9A-HJKMNP-TV-Z]{8}$/);
      assert.equal(code.length, USER_CODE_LENGTH);
      assert.equal(normalizeCrockfordCode(code, USER_CODE_LENGTH), code);
      seen.add(code);
    }
    assert.ok(seen.size > 490, "40 random bits rarely repeat");
  });

  test("verifyCode: two digits, every value reachable", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 5000; index += 1) {
      const code = newVerifyCode();
      assert.match(code, /^[0-9]{2}$/);
      seen.add(code);
    }
    assert.equal(seen.size, 100);
  });
});

describe("verifyChoices (DESIGN §4.10.4)", () => {
  test("three distinct VerifyCodes including the right one; stable for a link", () => {
    for (let index = 0; index < 300; index += 1) {
      const linkId = newId();
      const code = newVerifyCode();
      const choices = verifyChoices(KEY, linkId, code);
      assert.equal(choices.length, 3);
      assert.equal(new Set(choices).size, 3);
      assert.ok(choices.includes(code));
      for (const choice of choices) assert.match(choice, /^[0-9]{2}$/);
      assert.deepEqual(verifyChoices(KEY, linkId, code), choices, "same card on every read");
    }
  });

  test("the right number is at every position about equally often", () => {
    const positions = [0, 0, 0];
    const runs = 3000;
    for (let index = 0; index < runs; index += 1) {
      const code = "47";
      const position = verifyChoices(KEY, newId(), code).indexOf(code);
      positions[position] = (positions[position] ?? 0) + 1;
    }
    for (const count of positions) assert.ok(count > runs / 3 - 200 && count < runs / 3 + 200, String(positions));
  });

  test("depends on the server key", () => {
    const linkId = newId();
    const other = verifyChoicesKey(Buffer.alloc(32, 3));
    const differs = ["00", "13", "47", "99"].some(
      (code) => verifyChoices(KEY, linkId, code).join() !== verifyChoices(other, linkId, code).join(),
    );
    assert.ok(differs);
  });
});

function link(overrides: Partial<LinkRow> = {}): LinkRow {
  return {
    id: newId(),
    mode: "request",
    status: "pending",
    token_hash: "t".repeat(64),
    code_hash: "c".repeat(64),
    poll_secret_hash: null,
    user_id: null,
    approver_device_id: null,
    claimant_hwid_hash: null,
    claimant_name: null,
    claimant_platform: null,
    claimant_os_version: null,
    claimant_model: null,
    claimant_client_version: null,
    verify_code: null,
    deny_reason: null,
    creator_net: null,
    other_net: null,
    result_device_id: null,
    result_refresh_id: null,
    created_at: NOW,
    expires_at: NOW + 300_000,
    claimed_at: null,
    decided_at: null,
    completed_at: null,
    ...overrides,
  };
}

describe("effectiveStatus (DESIGN §4.10.3)", () => {
  const approver = newId();

  test("unfinished statuses become expired at expires_at; final ones never do", () => {
    const later = NOW + 300_000;
    assert.equal(effectiveStatus(link(), later - 1), "pending");
    assert.equal(effectiveStatus(link(), later), "expired");
    for (const status of ["claimed", "approved"]) {
      const row = link({ status, approver_device_id: approver });
      assert.equal(effectiveStatus(row, later - 1), status);
      assert.equal(effectiveStatus(row, later), "expired");
    }
    for (const status of ["denied", "cancelled", "completed"]) {
      assert.equal(effectiveStatus(link({ status }), later + HOUR_MS), status);
    }
  });

  test("an unfinished link whose approving device vanished is cancelled", () => {
    assert.equal(effectiveStatus(link({ status: "claimed" }), NOW), "cancelled");
    assert.equal(effectiveStatus(link({ status: "approved" }), NOW), "cancelled");
    assert.equal(effectiveStatus(link({ mode: "invite" }), NOW), "cancelled");
    assert.equal(effectiveStatus(link({ mode: "invite", approver_device_id: approver }), NOW), "pending");
    assert.equal(effectiveStatus(link({ mode: "request" }), NOW), "pending", "a request has no approver yet");
    assert.equal(effectiveStatus(link({ status: "completed" }), NOW), "completed");
  });
});

describe("sameNetwork (DESIGN §4.10.5)", () => {
  test("equal networks, different networks, unknown, hint off", () => {
    assert.equal(sameNetwork({ creator_net: "203.0.113.7", other_net: "203.0.113.7" }, true), true);
    assert.equal(sameNetwork({ creator_net: "203.0.113.7", other_net: "203.0.113.8" }, true), false);
    assert.equal(sameNetwork({ creator_net: "203.0.113.7", other_net: null }, true), null);
    assert.equal(sameNetwork({ creator_net: null, other_net: "203.0.113.7" }, true), null);
    assert.equal(sameNetwork({ creator_net: "203.0.113.7", other_net: "203.0.113.7" }, false), null);
  });
});

describe("DTOs of the issued session (API §4.1)", () => {
  test("UserDto", () => {
    const dto = userDto({
      id: newId(),
      login: "maxim",
      auth_version: 3,
      password_changed_at: NOW,
      recovery_code_created_at: NOW - HOUR_MS,
      recovery_code_confirmed_at: null,
      created_at: NOW - 2 * HOUR_MS,
    });
    UserDto.parse(dto);
    assert.deepEqual(dto.recoveryCodeStatus, { createdAt: "2026-09-23T09:00:00.000Z", confirmed: false });
    assert.equal(dto.createdAt, "2026-09-23T08:00:00.000Z");
  });

  test("DeviceDto of a linked device: current, recent for NEW_DEVICE_RESTRICT_HOURS", () => {
    const row: DeviceRow = {
      id: newId(),
      user_id: newId(),
      hwid_hash: "a".repeat(64),
      reported_name: "DESKTOP-7Q2",
      custom_name: null,
      platform: "windows",
      os_version: "11 24H2",
      model: null,
      client_version: "0.4.0",
      linked_via: "link",
      linked_by_device_id: newId(),
      created_at: NOW,
      last_seen_at: NOW,
      last_sync_at: null,
    };
    const dto = deviceDto(row, NOW, 24);
    DeviceDto.parse(dto);
    assert.equal(dto.name, "DESKTOP-7Q2");
    assert.equal(dto.isCurrent, true);
    assert.equal(dto.linkedVia, "link");
    assert.equal(dto.recentUntil, "2026-09-24T10:00:00.000Z");
    assert.equal(deviceDto({ ...row, custom_name: "Работа" }, NOW, 24).name, "Работа");
    assert.equal(deviceDto(row, NOW + 24 * HOUR_MS, 24).recentUntil, null);
  });
});
