/**
 * The event catalog (API §6): every type of the contract has an entry, the envelope is checked against the payload
 * schema, and the frames have the exact wire format (no `event:` line).
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LIVE_EVENT_PAYLOADS, LIVE_EVENT_TYPES } from "../../contract/live.ts";
import {
  buildLiveEvent,
  isLiveEventType,
  LIVE_EVENTS,
  LivePayloadError,
  sseEventFrame,
  sseHeartbeatFrame,
  sseRetryFrame,
} from "./live.events.ts";

const T0 = Date.UTC(2026, 8, 30, 8, 0, 0, 200);

describe("live event catalog (API §6)", () => {
  test("one entry per event type, with the payload schema of the contract", () => {
    assert.deepEqual(Object.keys(LIVE_EVENTS).sort(), [...LIVE_EVENT_TYPES].sort());
    for (const type of LIVE_EVENT_TYPES) assert.equal(LIVE_EVENTS[type].payload, LIVE_EVENT_PAYLOADS[type]);
  });

  test("audiences and coalescing follow the table of API §6", () => {
    const table = Object.fromEntries(
      LIVE_EVENT_TYPES.map((type) => [type, [LIVE_EVENTS[type].audience, LIVE_EVENTS[type].coalesceMs]]),
    );
    assert.deepEqual(table, {
      "system.connected": ["stream", null],
      "sync.changed": ["others", 2000],
      "playback.updated": ["others", 1000],
      "devices.updated": ["user", null],
      "session.invalidated": ["device", null],
      "account.updated": ["others", null],
      "link.updated": ["device", null],
      "lyrics.changed": ["others", 2000],
    });
    assert.ok(isLiveEventType("sync.changed"));
    assert.ok(!isLiveEventType("sync.unknown"));
  });

  test("buildLiveEvent checks the payload", () => {
    const event = buildLiveEvent(
      "account.updated",
      {
        reason: "password_changed_without_old",
        byDevice: { id: "77b2c1d0-3e4f-4a5b-8c6d-7e8f9a0b1c2d", name: "MacBook Air" },
      },
      T0,
      "1f2e3d4c-5b6a-4978-8a7b-6c5d4e3f2a1b",
    );
    assert.equal(event.at, "2026-09-30T08:00:00.200Z");
    assert.throws(
      () => buildLiveEvent("link.updated", { linkId: 5 } as unknown as { linkId: string; status: string }, T0),
      LivePayloadError,
    );
  });

  test("frames: retry first, events as id + data without event:, heartbeats as comments (API §6 example)", () => {
    const event = buildLiveEvent(
      "account.updated",
      {
        reason: "password_changed_without_old",
        byDevice: { id: "77b2c1d0-3e4f-4a5b-8c6d-7e8f9a0b1c2d", name: "MacBook Air" },
      },
      T0,
      "1f2e3d4c-5b6a-4978-8a7b-6c5d4e3f2a1b",
    );
    assert.equal(sseRetryFrame(), "retry: 5000\n\n");
    assert.equal(
      sseEventFrame(event),
      'id: 1f2e3d4c-5b6a-4978-8a7b-6c5d4e3f2a1b\ndata: {"id":"1f2e3d4c-5b6a-4978-8a7b-6c5d4e3f2a1b","type":"account.updated","at":"2026-09-30T08:00:00.200Z","payload":{"reason":"password_changed_without_old","byDevice":{"id":"77b2c1d0-3e4f-4a5b-8c6d-7e8f9a0b1c2d","name":"MacBook Air"}}}\n\n',
    );
    assert.ok(!sseEventFrame(event).includes("event:"));
    assert.equal(sseHeartbeatFrame(1790157625000), ": heartbeat 1790157625000\n\n");
  });
});
