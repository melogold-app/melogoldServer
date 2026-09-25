/**
 * Every JSON example of `docs/API.md` (and the SSE frame of §6) against the contract:
 * - request examples pass the request schema (what the route validates);
 * - response examples pass the response schema (structure) **and** the formats documented in OpenAPI (patterns,
 *   lengths, ranges), checked by a small interpreter of the rendered JSON schema.
 * A new example without a mapping below fails, so it gets checked too.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { z } from "zod";
import { CONTRACT_COMPONENTS, LIVE_EVENT_PAYLOADS, LIVE_EVENT_TYPES, SyncRequestEnvelope } from "./index.ts";
import type { LiveEventType } from "./index.ts";

const API = readFileSync(new URL("../../docs/API.md", import.meta.url), "utf8");

type Json = Record<string, unknown>;

const BY_ID = new Map(CONTRACT_COMPONENTS.map((c) => [c.id, c]));

function schemaOf(id: string): z.ZodType {
  const component = BY_ID.get(id);
  assert.ok(component, `no component ${id}`);
  return component.schema;
}

// ---------------------------------------------------------------------------------------------------------------------
// Documented formats: a small interpreter of the OpenAPI 3.0 subset the contract renders
// ---------------------------------------------------------------------------------------------------------------------

type JsonSchema = {
  $ref?: string;
  allOf?: JsonSchema[];
  type?: string;
  nullable?: boolean;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  enum?: unknown[];
};

const RENDERED: Record<string, JsonSchema> = (() => {
  const registry = new z.core.$ZodRegistry<{ id?: string }>();
  for (const c of CONTRACT_COMPONENTS) if (c.direction === "response") registry.add(c.schema, { id: c.id });
  const uri = (id: string) => `#/components/schemas/${id}`;
  return z.toJSONSchema(registry, { target: "openapi-3.0", io: "output", uri }).schemas as Record<string, JsonSchema>;
})();

/**
 * Deliberately lenient in one place: `null` passes a schema with `nullable: true` **before** its `allOf` is looked at.
 * That is the convention of API §1.3 for a nullable component (`{type: object, nullable: true, allOf: [{$ref}]}`);
 * a literal OpenAPI 3.0.3 validator would evaluate the `allOf` and reject `null` (the zod schemas accept it).
 */
function documentedViolations(value: unknown, schema: JsonSchema, path: string, out: string[]): void {
  if (schema.$ref !== undefined) {
    const target = RENDERED[schema.$ref.replace("#/components/schemas/", "")];
    assert.ok(target, `unresolved ${schema.$ref}`);
    documentedViolations(value, target, path, out);
    return;
  }
  if (value === null) {
    if (schema.nullable !== true) out.push(`${path}: null`);
    return;
  }
  for (const part of schema.allOf ?? []) documentedViolations(value, part, path, out);
  if (typeof value === "string") {
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) out.push(`${path}: pattern ${value}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) out.push(`${path}: maxLength`);
    if (schema.minLength !== undefined && value.length < schema.minLength) out.push(`${path}: minLength`);
  } else if (typeof value === "number") {
    if (schema.maximum !== undefined && value > schema.maximum) out.push(`${path}: maximum`);
    if (schema.minimum !== undefined && value < schema.minimum) out.push(`${path}: minimum`);
  } else if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) out.push(`${path}: maxItems`);
    if (schema.minItems !== undefined && value.length < schema.minItems) out.push(`${path}: minItems`);
    value.forEach((item, index) => {
      if (schema.items) documentedViolations(item, schema.items, `${path}[${index}]`, out);
    });
  } else if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const property = schema.properties?.[key];
      if (property) documentedViolations(child, property, `${path}.${key}`, out);
    }
  }
}

/**
 * Known errors of API.md examples, reported to the lead (API.md is normative and not edited here). The pollSecret
 * of the §4.6 examples has 42 characters after `mgps_`; API §1.6 `PollSecret` says 43. When API.md is fixed, the
 * entry must go (the assertion below compares exactly).
 */
const KNOWN_EXAMPLE_ERRATA: ReadonlyMap<string, readonly string[]> = new Map([
  ["LinkCreated", ["LinkCreated.pollSecret: pattern mgps_Zr8aB3cD4eF5gH6iJ7kL8mN9oP0qR1sT2uV3wX4yZ5"]],
  ["LinkClaimed", ["LinkClaimed.pollSecret: pattern mgps_Zr8aB3cD4eF5gH6iJ7kL8mN9oP0qR1sT2uV3wX4yZ5"]],
]);

function checkResponse(id: string, example: unknown): void {
  const result = schemaOf(id).safeParse(example);
  assert.ok(result.success, `${id}: ${JSON.stringify(result.error?.issues)}`);
  const violations: string[] = [];
  const rendered = RENDERED[id];
  assert.ok(rendered, id);
  documentedViolations(example, rendered, id, violations);
  assert.deepEqual(violations, KNOWN_EXAMPLE_ERRATA.get(id) ?? [], `${id}: example breaks documented formats`);
}

function checkRequest(id: string, example: unknown): unknown {
  const result = schemaOf(id).safeParse(example);
  assert.ok(result.success, `${id}: ${JSON.stringify(result.error?.issues)}`);
  return result.data;
}

// ---------------------------------------------------------------------------------------------------------------------
// Which component each example shows
// ---------------------------------------------------------------------------------------------------------------------

type Rule = Readonly<{ id: string; direction: "request" | "response"; matches: (json: Json) => boolean }>;

const has = (json: Json, ...keys: string[]) => keys.every((key) => key in json);

const RULES: readonly Rule[] = [
  { id: "ErrorResponse", direction: "response", matches: (j) => has(j, "statusCode", "code") },
  { id: "TrackDto", direction: "response", matches: (j) => has(j, "videoId", "metadataStub") },
  { id: "HealthResponse", direction: "response", matches: (j) => has(j, "status", "db") },
  { id: "ServerInfo", direction: "response", matches: (j) => has(j, "software") },
  { id: "RegisterChallenge", direction: "response", matches: (j) => has(j, "challenge", "bits") },
  { id: "RegisterRequest", direction: "request", matches: (j) => has(j, "login", "password", "device", "pow") },
  { id: "LoginRequest", direction: "request", matches: (j) => has(j, "login", "password", "device") },
  { id: "AuthSession", direction: "response", matches: (j) => has(j, "user", "device", "tokens") },
  { id: "RefreshRequest", direction: "request", matches: (j) => has(j, "refreshToken", "device") },
  { id: "MeResponse", direction: "response", matches: (j) => has(j, "user", "device", "serverTime") },
  { id: "DeviceListResponse", direction: "response", matches: (j) => has(j, "devices", "maxDevices") },
  { id: "ChangePasswordRequest", direction: "request", matches: (j) => has(j, "newPassword") && !has(j, "login") },
  { id: "ChangePasswordResponse", direction: "response", matches: (j) => has(j, "user", "tokens", "signedOutDevices") },
  { id: "RecoverRequest", direction: "request", matches: (j) => has(j, "login", "recoveryCode", "newPassword") },
  { id: "ExportDocument", direction: "response", matches: (j) => j.format === "melogold-export" },
  { id: "LinkCreated", direction: "response", matches: (j) => has(j, "linkId", "mode", "linkToken") },
  { id: "LinkClaimed", direction: "response", matches: (j) => has(j, "linkId", "pollSecret", "verifyCode") },
  { id: "ClaimLinkRequest", direction: "request", matches: (j) => has(j, "device") && has(j, "userCode") },
  { id: "CreateLinkRequestRequest", direction: "request", matches: (j) => Object.keys(j).join() === "device" },
  { id: "SyncSummary", direction: "response", matches: (j) => has(j, "counts") },
  { id: "MergePlanResponse", direction: "response", matches: (j) => has(j, "plan") },
  { id: "SyncRequest", direction: "request", matches: (j) => has(j, "cursor", "ops") },
  { id: "SyncResponse", direction: "response", matches: (j) => has(j, "results") },
  { id: "PlaybackPut", direction: "request", matches: (j) => has(j, "sessionId", "queueVersion", "playing") },
  { id: "PlaybackPutResult", direction: "response", matches: (j) => has(j, "applied") },
  { id: "LyricsPut", direction: "request", matches: (j) => has(j, "syncedFormat") && !has(j, "videoId") },
  { id: "LyricsResponse", direction: "response", matches: (j) => has(j, "mine", "shared") },
  { id: "MyLyricsPage", direction: "response", matches: (j) => has(j, "items", "more") },
];

/** Examples of API.md with an abbreviated value (`…`) that no schema can accept; the field is removed first. */
const ABBREVIATED: ReadonlyMap<string, string> = new Map([["RegisterRequest", "pow"]]);

function examples(): Json[] {
  return [...API.matchAll(/^[ \t]*```json\n([\s\S]*?)^[ \t]*```/gm)].map((block) => {
    const parsed: unknown = JSON.parse(block[1] ?? "");
    assert.ok(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed));
    return parsed as Json;
  });
}

describe("API.md examples", () => {
  const all = examples();

  test("every example is mapped to a component", () => {
    assert.equal(all.length, 29);
    const unmapped = all.filter((json) => !RULES.some((rule) => rule.matches(json)));
    assert.deepEqual(unmapped, []);
    const used = new Set(all.map((json) => RULES.find((rule) => rule.matches(json))?.id));
    assert.deepEqual(
      RULES.map((rule) => rule.id).filter((id) => !used.has(id)),
      [],
    );
  });

  for (const [index, json] of all.entries()) {
    const rule = RULES.find((candidate) => candidate.matches(json));
    test(`example ${index + 1}: ${rule?.id ?? "?"}`, () => {
      assert.ok(rule);
      assert.equal(BY_ID.get(rule.id)?.direction, rule.direction, `${rule.id} direction`);
      if (rule.direction === "response") {
        checkResponse(rule.id, json);
        return;
      }
      const abbreviated = ABBREVIATED.get(rule.id);
      const input = abbreviated === undefined ? json : { ...json, [abbreviated]: undefined };
      checkRequest(rule.id, input);
    });
  }

  test("request examples come out normalized", () => {
    const recover = checkRequest(
      "RecoverRequest",
      all.find((json) => has(json, "recoveryCode", "newPassword")),
    ) as {
      recoveryCode: string;
    };
    assert.equal(recover.recoveryCode, "7KQ2MX9D4TNPB8RW3HZF");
    const claim = checkRequest(
      "ClaimLinkRequest",
      all.find((json) => has(json, "userCode", "device")),
    ) as {
      userCode: string;
      linkToken: unknown;
    };
    assert.equal(claim.userCode, "K7QXM2PD");
    assert.equal(claim.linkToken, undefined);
    // The route validates the envelope; the typed SyncRequest documents it. Both accept the example.
    const syncExample = all.find((json) => has(json, "cursor", "ops"));
    checkRequest("SyncRequest", syncExample);
    const envelope = SyncRequestEnvelope.parse(syncExample);
    // "2026-09-23T10:00:00.123456Z" is truncated to milliseconds; other op fields pass through untouched.
    const [first, second] = envelope.ops ?? [];
    assert.ok(first && second);
    assert.equal(first.at, Date.UTC(2026, 8, 23, 10, 0, 0, 123));
    assert.equal(first.videoId, "a1B2c3D4e5F");
    assert.deepEqual(second.tracks, [{ videoId: "abcdefghijk", title: "" }]);
  });

  test("the SSE frame of §6 is a LiveEvent with its payload", () => {
    const frame = /^data: (\{.*\})$/m.exec(API.slice(API.indexOf("## 6. ")));
    assert.ok(frame);
    const event = JSON.parse(frame[1] ?? "") as { type: LiveEventType; payload: unknown };
    checkResponse("LiveEvent", event);
    assert.ok(LIVE_EVENT_TYPES.includes(event.type));
    const payloadId = BY_ID.get(`${event.type === "account.updated" ? "AccountUpdated" : "?"}Payload`)?.id;
    assert.equal(payloadId, "AccountUpdatedPayload");
    checkResponse(payloadId, event.payload);
    assert.ok(LIVE_EVENT_PAYLOADS[event.type].safeParse(event.payload).success);
  });
});
