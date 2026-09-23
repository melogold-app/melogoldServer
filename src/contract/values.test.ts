/**
 * Constants of the contract equal `docs/API.md`: op kinds with their fields (§4.8 table), `features.sync` and
 * `limits` of the §4.2 example, SSE types and reasons (§6), the enumerations written in comments of §4, and the body
 * limits of §1.9 as the HTTP layer applies them.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { parseEnv } from "../config/env.ts";
import { BODY_LIMITS } from "../http/route-policy.ts";
import type {
  DevicesUpdatedReason as RemovalDevicesUpdatedReason,
  SessionInvalidatedReason as RemovalSessionInvalidatedReason,
} from "../lib/device-removal.ts";
import {
  ACCOUNT_UPDATED_REASON_VALUES,
  BOOKMARK_TYPE_VALUES,
  DEVICES_UPDATED_REASON_VALUES,
  LINKED_VIA_VALUES,
  LINK_DECISION_VALUES,
  LINK_MODE_VALUES,
  LINK_POLL_STATUS_VALUES,
  LINK_STATUS_VALUES,
  LINK_UPDATED_STATUS_VALUES,
  LIVE_EVENT_TYPES,
  MERGE_ACTION_VALUES,
  OP_STATUS_VALUES,
  PLAYBACK_LIMITS,
  PLAYBACK_REJECT_REASON_VALUES,
  SESSION_INVALIDATED_REASON_VALUES,
  SYNC_LIMITS,
  SYNC_OP_KINDS,
  SYNC_OP_KIND_SPECS,
  SYNC_STREAM_VALUES,
  SyncOp,
  buildServerLimits,
  isSyncOpKind,
} from "./index.ts";

const API = readFileSync(new URL("../../docs/API.md", import.meta.url), "utf8");

function between(start: string, end: string): string {
  const from = API.indexOf(start);
  const to = API.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${start} not found`);
  return API.slice(from, to);
}

function tableRows(text: string): string[][] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("|") && !/^\|\s*-/.test(line))
    .slice(1)
    .map((line) =>
      line
        .replaceAll("\\|", "\u0001")
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.replaceAll("\u0001", "|").trim()),
    );
}

const backticked = (cell: string): string[] => [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "");

/** `a|b|c` after `marker` in API.md. */
function listAfter(marker: RegExp): string[] {
  const match = marker.exec(API);
  assert.ok(match?.[1], `${marker} not found in API.md`);
  return match[1].split("|");
}

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe("op kinds (API §4.8)", () => {
  const rows = tableRows(between("**Виды ops.**", "**Мягкая нормализация"));
  const opFields = new Set(Object.keys(SyncOp.shape).filter((key) => !["opId", "kind", "at", "base"].includes(key)));
  // Parenthesized notes name sub-fields (`entries` (… unique `videoId`)), not op fields.
  const fieldsOf = (cell: string) => backticked(cell.replace(/\([^)]*\)/g, "")).filter((token) => opFields.has(token));

  test("kinds, required and optional fields, entity keys, videoIds ranges", () => {
    assert.deepEqual(
      rows.map((row) => backticked(row[0] ?? "")[0]),
      [...SYNC_OP_KINDS],
    );
    for (const [kindCell = "", requiredCell = "", optionalCell = "", keyCell = ""] of rows) {
      const kind = backticked(kindCell)[0] ?? "";
      assert.ok(isSyncOpKind(kind), kind);
      const spec = SYNC_OP_KIND_SPECS[kind];
      assert.deepEqual([...new Set(fieldsOf(requiredCell))].sort(), [...spec.required].sort(), `${kind} required`);
      assert.deepEqual([...new Set(fieldsOf(optionalCell))].sort(), [...spec.optional].sort(), `${kind} optional`);
      assert.deepEqual(backticked(keyCell), [spec.entityKey], `${kind} entityKey`);
      const range = /`videoIds` \((\d+)\.\.(\d+)\)/.exec(`${requiredCell} ${optionalCell}`);
      const specRange = "videoIds" in spec ? spec.videoIds : undefined;
      assert.deepEqual(specRange, range ? { min: Number(range[1]), max: Number(range[2]) } : undefined, kind);
    }
  });

  test("streams and journaling (DESIGN §3.6, §3.7)", () => {
    for (const kind of SYNC_OP_KINDS) {
      const spec = SYNC_OP_KIND_SPECS[kind];
      assert.equal(spec.stream, kind.startsWith("play.") || kind.startsWith("history.") ? "history" : "library", kind);
      assert.equal(spec.journaled, kind !== "play.add", kind);
    }
    assert.equal(isSyncOpKind("constructor"), false);
    assert.equal(isSyncOpKind("like.get"), false);
  });
});

describe("/server/info example (API §4.2, §11)", () => {
  const example = JSON.parse(/^(\{"software":[\s\S]*?\})\n```/m.exec(API)?.[1] ?? "{}") as {
    features: { sync: { kinds: string[]; streams: string[]; protocol: number } };
    limits: unknown;
  };

  test("features.sync lists every kind and stream", () => {
    assert.deepEqual(example.features.sync.kinds, [...SYNC_OP_KINDS]);
    assert.deepEqual(example.features.sync.streams, [...SYNC_STREAM_VALUES]);
  });

  test("limits with the default environment", () => {
    assert.deepEqual(buildServerLimits(parseEnv({})), example.limits);
  });

  test("body limits agree with the HTTP layer (API §1.9)", () => {
    assert.equal(SYNC_LIMITS.maxBodyBytes, BODY_LIMITS.sync);
    assert.equal(PLAYBACK_LIMITS.maxBodyBytes, BODY_LIMITS.playback);
  });
});

describe("SSE (API §6)", () => {
  const rows = tableRows(between("| type | Кому |", "```ts\ntype PlaybackSummary"));
  const reasons = (type: string, field: string): string[] => {
    const row = rows.find((cells) => backticked(cells[0] ?? "")[0] === type);
    assert.ok(row, type);
    const match = new RegExp(`${field}: \`([^\`]+)\``).exec(row[2] ?? "");
    assert.ok(match?.[1], `${type} ${field}`);
    return match[1].split("|");
  };

  test("event types", () => {
    assert.deepEqual(
      rows.map((row) => backticked(row[0] ?? "")[0]),
      [...LIVE_EVENT_TYPES],
    );
  });

  test("reasons and statuses", () => {
    assert.deepEqual(reasons("devices.updated", "reason"), [...DEVICES_UPDATED_REASON_VALUES]);
    assert.deepEqual(reasons("session.invalidated", "reason"), [...SESSION_INVALIDATED_REASON_VALUES]);
    assert.deepEqual(reasons("account.updated", "reason"), [...ACCOUNT_UPDATED_REASON_VALUES]);
    assert.deepEqual(reasons("link.updated", "status"), [...LINK_UPDATED_STATUS_VALUES]);
  });

  test("device removal publishes the same reasons (src/lib/device-removal.ts)", () => {
    const sessionInvalidated: Equal<
      RemovalSessionInvalidatedReason,
      (typeof SESSION_INVALIDATED_REASON_VALUES)[number]
    > = true;
    const devicesUpdated: Equal<RemovalDevicesUpdatedReason, (typeof DEVICES_UPDATED_REASON_VALUES)[number]> = true;
    assert.equal(sessionInvalidated, true);
    assert.equal(devicesUpdated, true);
  });
});

describe("enumerations written in API §4 comments", () => {
  test("values equal API.md", () => {
    assert.deepEqual(listAfter(/linkedVia: string;\s*\/\/ ([\w|]+)/), [...LINKED_VIA_VALUES]);
    assert.deepEqual(listAfter(/mode: string \/\*([\w|]+)\*\//), [...LINK_MODE_VALUES]);
    assert.deepEqual(listAfter(/status: string;\s*\/\/ (pending\|claimed\|approved[\w|]+)/), [...LINK_STATUS_VALUES]);
    assert.deepEqual(listAfter(/status: string;\s*\/\/ (pending\|claimed\|completed)\s/), [...LINK_POLL_STATUS_VALUES]);
    assert.deepEqual(listAfter(/LinkDecisionResponse = .*status: string \/\*([\w|]+)\*\//), [...LINK_DECISION_VALUES]);
    assert.deepEqual(listAfter(/action: string \/\*([\w|]+)\*\//), [...MERGE_ACTION_VALUES]);
    assert.deepEqual(listAfter(/BookmarkKey = \{ type: string \/\*([\w|]+)\*\//), [...BOOKMARK_TYPE_VALUES]);
    assert.deepEqual(listAfter(/status: string;\s*\/\/ (applied[\w|]+)/), [...OP_STATUS_VALUES]);
    assert.deepEqual(listAfter(/reason: string \| null;\s*\/\/ ([\w|]+)/), [...PLAYBACK_REJECT_REASON_VALUES]);
  });
});
