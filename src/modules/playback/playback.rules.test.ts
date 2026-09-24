/**
 * `decidePlaybackPut`/`decidePlaybackDelete` (DESIGN §3.12.3): unit tests plus the shared vectors of
 * `spec/playback-rules.vectors.json`, so a change to the rule engine is checked against every named scenario at once.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { TrackDto } from "../../contract/common.ts";
import { decidePlaybackDelete, decidePlaybackPut } from "./playback.rules.ts";
import type { NewPlaybackRow, PutInput, StoredPlayback } from "./playback.rules.ts";

const VECTORS_PATH = fileURLToPath(new URL("../../../spec/playback-rules.vectors.json", import.meta.url));

type VectorTrackFields = { queueLength: number | null };

type VectorStored = Readonly<
  {
    rev: number;
    cleared: boolean;
    deviceId: string;
    deviceName: string | null;
    sessionId: string;
    queueVersion: number;
    index: number;
    positionMs: number;
    durationMs: number | null;
    playing: boolean;
    stateAt: number;
    updatedAt: number;
    handoffDeviceId: string | null;
    handoffSessionId: string | null;
    handoffAt: number | null;
  } & VectorTrackFields
>;

type VectorPutInput = Readonly<
  {
    deviceId: string;
    deviceName: string | null;
    sessionId: string;
    queueVersion: number;
    atMs: number;
    index: number;
    positionMs: number;
    durationMs: number | null;
    playing: boolean;
    handoffFrom: Readonly<{ deviceId: string; sessionId: string }> | null;
  } & VectorTrackFields
>;

type VectorPutCase = Readonly<{
  name: string;
  stored: VectorStored | null;
  input: VectorPutInput;
  nowMs: number;
  expect: Readonly<{
    type: "handed_off" | "newer_state" | "queue_required" | "invalid_index" | "write";
    rev?: number;
    significant?: boolean;
    handoff?: Readonly<{ deviceId: string; sessionId: string; at: number }> | null;
    queueLength?: number;
  }>;
}>;

type VectorDeleteCase = Readonly<{
  name: string;
  stored: VectorStored | null;
  input: Readonly<{ deviceId: string; fallbackSessionId: string }>;
  nowMs: number;
  expect: Readonly<{ rev: number; deviceId: string; sessionId: string; queueVersion: number; stateAt?: number }>;
}>;

type Vectors = Readonly<{ put: readonly VectorPutCase[]; delete: readonly VectorDeleteCase[] }>;

const vectors = JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as Vectors;

/** A deterministic placeholder `TrackDto`, distinct per index (11-character `VideoId`). */
function placeholderTrack(index: number): TrackDto {
  const videoId = `track${String(index).padStart(6, "0")}`;
  return {
    videoId,
    title: `Track ${index}`,
    artistsText: null,
    artists: [],
    albumId: null,
    albumTitle: null,
    durationMs: null,
    durationText: null,
    thumbnailUrl: null,
    explicit: false,
    videoType: null,
    metadataStub: false,
  };
}

function queueOf(length: number | null): TrackDto[] | undefined {
  return length === null ? undefined : Array.from({ length }, (_, index) => placeholderTrack(index));
}

function toStored(vector: VectorStored | null): StoredPlayback | null {
  if (vector === null) return null;
  const queue = queueOf(vector.queueLength);
  return {
    rev: vector.rev,
    cleared: vector.cleared,
    deviceId: vector.deviceId,
    deviceName: vector.deviceName,
    sessionId: vector.sessionId,
    queueVersion: vector.queueVersion,
    queue: queue ?? [],
    index: vector.index,
    positionMs: vector.positionMs,
    durationMs: vector.durationMs,
    playing: vector.playing,
    stateAt: vector.stateAt,
    updatedAt: vector.updatedAt,
    handoffDeviceId: vector.handoffDeviceId,
    handoffSessionId: vector.handoffSessionId,
    handoffAt: vector.handoffAt,
  };
}

function toPutInput(vector: VectorPutInput): PutInput {
  const queue = queueOf(vector.queueLength);
  return {
    deviceId: vector.deviceId,
    deviceName: vector.deviceName,
    sessionId: vector.sessionId,
    queueVersion: vector.queueVersion,
    atMs: vector.atMs,
    index: vector.index,
    positionMs: vector.positionMs,
    durationMs: vector.durationMs,
    playing: vector.playing,
    ...(queue === undefined ? {} : { queue }),
    ...(vector.handoffFrom === null ? {} : { handoffFrom: vector.handoffFrom }),
  };
}

describe("decidePlaybackPut: spec/playback-rules.vectors.json", () => {
  for (const vector of vectors.put) {
    test(vector.name, () => {
      const stored = toStored(vector.stored);
      const decision = decidePlaybackPut(stored, toPutInput(vector.input), vector.nowMs);
      assert.equal(decision.type, vector.expect.type, vector.name);
      if (decision.type !== "write") return;
      const row: NewPlaybackRow = decision.row;
      if (vector.expect.rev !== undefined) assert.equal(row.rev, vector.expect.rev, "rev");
      if (vector.expect.significant !== undefined) {
        assert.equal(decision.significant, vector.expect.significant, "significant");
      }
      if (vector.expect.handoff !== undefined) {
        if (vector.expect.handoff === null) {
          assert.equal(row.handoffDeviceId, null, "handoffDeviceId");
          assert.equal(row.handoffSessionId, null, "handoffSessionId");
          assert.equal(row.handoffAt, null, "handoffAt");
        } else {
          assert.equal(row.handoffDeviceId, vector.expect.handoff.deviceId, "handoffDeviceId");
          assert.equal(row.handoffSessionId, vector.expect.handoff.sessionId, "handoffSessionId");
          assert.equal(row.handoffAt, vector.expect.handoff.at, "handoffAt");
        }
      }
      if (vector.expect.queueLength !== undefined) assert.equal(row.queue.length, vector.expect.queueLength, "queue");
    });
  }
});

describe("decidePlaybackDelete: spec/playback-rules.vectors.json", () => {
  for (const vector of vectors.delete) {
    test(vector.name, () => {
      const stored = toStored(vector.stored);
      const row = decidePlaybackDelete(stored, vector.input, vector.nowMs);
      assert.equal(row.rev, vector.expect.rev, "rev");
      assert.equal(row.deviceId, vector.expect.deviceId, "deviceId");
      assert.equal(row.sessionId, vector.expect.sessionId, "sessionId");
      assert.equal(row.queueVersion, vector.expect.queueVersion, "queueVersion");
      assert.equal(row.queue.length, 0, "queue is emptied");
      assert.equal(row.playing, false, "playing is reset");
      assert.equal(row.handoffDeviceId, null, "handoff is cleared");
      if (vector.expect.stateAt !== undefined) assert.equal(row.stateAt, vector.expect.stateAt, "stateAt");
    });
  }
});

describe("decidePlaybackPut: unit cases beyond the vectors", () => {
  test("rev never goes backward even when now is behind a very fresh rev (m18)", () => {
    const stored: StoredPlayback = {
      rev: 9_000_000_000,
      cleared: false,
      deviceId: "a",
      deviceName: null,
      sessionId: "s1",
      queueVersion: 1,
      queue: [placeholderTrack(0)],
      index: 0,
      positionMs: 0,
      durationMs: null,
      playing: false,
      stateAt: 100,
      updatedAt: 100,
      handoffDeviceId: null,
      handoffSessionId: null,
      handoffAt: null,
    };
    const decision = decidePlaybackPut(
      stored,
      {
        deviceId: "a",
        deviceName: null,
        sessionId: "s1",
        queueVersion: 1,
        atMs: 200,
        index: 0,
        positionMs: 0,
        durationMs: null,
        playing: false,
      },
      200,
    );
    assert.equal(decision.type, "write");
    assert.equal(decision.row.rev, 9_000_000_001);
  });

  test("eff = min(at, now): a client clock far in the future is clamped to now", () => {
    const decision = decidePlaybackPut(
      null,
      {
        deviceId: "a",
        deviceName: null,
        sessionId: "s1",
        queueVersion: 0,
        atMs: 999_999_999,
        index: 0,
        positionMs: 0,
        durationMs: null,
        playing: false,
        queue: [placeholderTrack(0)],
      },
      1000,
    );
    assert.equal(decision.type, "write");
    assert.equal(decision.row.stateAt, 1000);
  });
});
