/**
 * The OpenAPI document (API §1.1, DESIGN §10 contract tests):
 * - the committed `openapi/openapi.json` and `openapi.yaml` are exactly what the code generates (`npm run openapi`);
 * - OpenAPI 3.0.3, CC0-1.0 (DESIGN §12), SPDX header in the YAML;
 * - the operations are the rows of API §3 with their `operationId`, 2xx status, security and `X-Sync-Protocol`;
 * - every operation has a 4xx answer (the two health probes excepted) and every error answer is `ErrorResponse`
 *   with registered codes of that status;
 * - no inline object schemas: bodies and answers are components, every `$ref` resolves, the components are exactly
 *   the contract (`CONTRACT_COMPONENTS`, including every `*Payload` and `PlaybackSummary`).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, describe, test } from "node:test";
import { generateOpenapi } from "../../../scripts/gen-openapi.ts";
import type { OpenapiDocuments } from "../../../scripts/gen-openapi.ts";
import { CONTRACT_COMPONENTS } from "../../contract/index.ts";
import { ERROR_CODES, isErrorCode } from "../../http/error-codes.ts";
import { apiRoutes } from "./api-table.ts";

type Json = Record<string, unknown>;
type Operation = {
  operationId?: string;
  tags?: string[];
  security?: Json[];
  parameters?: { in: string; name: string; required?: boolean; schema?: Json }[];
  requestBody?: { content: Record<string, { schema: Json }> };
  responses: Record<string, { description: string; content?: Record<string, { schema: Json }> }>;
};

const ROOT = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, ROOT), "utf8");
const PROBES = new Set(["getHealth", "getLiveness"]);
const METHODS = ["get", "put", "post", "delete", "patch"];

let generated: OpenapiDocuments;
let doc: Json;
let operations: { method: string; path: string; op: Operation }[];

before(async () => {
  generated = await generateOpenapi();
  doc = generated.document;
  const paths = doc.paths as Record<string, Record<string, Operation>>;
  operations = Object.entries(paths).flatMap(([path, item]) =>
    METHODS.filter((method) => item[method] !== undefined).map((method) => ({
      method: method.toUpperCase(),
      path,
      op: item[method]!,
    })),
  );
});

function refsIn(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) for (const item of node) refsIn(item, found);
  else if (typeof node === "object" && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") found.push(value);
      else refsIn(value, found);
    }
  }
  return found;
}

describe("OpenAPI document", () => {
  test("the committed files are generated from the code (npm run openapi)", () => {
    assert.equal(read("openapi/openapi.json"), generated.json, "openapi/openapi.json is stale: run npm run openapi");
    assert.equal(read("openapi/openapi.yaml"), generated.yaml, "openapi/openapi.yaml is stale: run npm run openapi");
  });

  test("OpenAPI 3.0.3 under CC0-1.0", () => {
    assert.equal(doc.openapi, "3.0.3");
    assert.deepEqual((doc.info as Json).license, {
      name: "CC0-1.0",
      url: "https://creativecommons.org/publicdomain/zero/1.0/",
    });
    assert.ok(generated.yaml.startsWith("# SPDX-License-Identifier: CC0-1.0\n"));
    for (const file of ["openapi/LICENSE", "spec/LICENSE"]) {
      assert.match(read(file), /^Creative Commons Legal Code\n\nCC0 1\.0 Universal\n/, file);
    }
  });

  test("operations are the rows of API §3 with operationId, status, security and X-Sync-Protocol", () => {
    const expected = apiRoutes().filter((route) => route.operationId !== null);
    assert.equal(expected.length, 36);
    assert.deepEqual(
      operations.map(({ method, path }) => `${method} ${path}`).sort(),
      expected.map((route) => `${route.method} ${route.path}`).sort(),
    );
    for (const route of expected) {
      const { op } = operations.find((item) => item.method === route.method && item.path === route.path)!;
      const where = `${route.method} ${route.path}`;
      assert.equal(op.operationId, route.operationId, where);
      assert.equal(op.tags?.length, 1, `${where}: one tag`);
      assert.ok(op.responses[String(route.status)], `${where}: ${route.status} answer`);
      const successes = Object.keys(op.responses).filter((status) => status.startsWith("2"));
      assert.deepEqual(successes, [String(route.status)], where);
      assert.deepEqual(op.security, route.auth === "bearer" ? [{ bearerAuth: [] }] : [], `${where}: security`);
      const header = op.parameters?.find(
        (parameter) => parameter.in === "header" && parameter.name === "X-Sync-Protocol",
      );
      assert.equal(header?.required === true, route.syncProtocol, `${where}: X-Sync-Protocol`);
      const content = op.responses[String(route.status)]?.content;
      if (route.status === 204) assert.equal(content, undefined, where);
      else
        assert.deepEqual(
          Object.keys(content ?? {}),
          [route.media === "sse" ? "text/event-stream" : "application/json"],
          where,
        );
    }
    const ids = operations.map(({ op }) => op.operationId);
    assert.equal(new Set(ids).size, ids.length, "operationId is unique");
  });

  test("every operation has a 4xx answer; every error answer is ErrorResponse with registered codes", () => {
    for (const { method, path, op } of operations) {
      const where = `${method} ${path}`;
      const errors = Object.keys(op.responses).filter((status) => !status.startsWith("2"));
      if (!PROBES.has(op.operationId ?? "")) {
        assert.ok(
          errors.some((status) => status.startsWith("4")),
          `${where}: no 4xx answer`,
        );
      }
      assert.ok(errors.includes("500"), `${where}: 500`);
      for (const status of errors) {
        const answer = op.responses[status]!;
        assert.deepEqual(answer.content, {
          "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
        });
        const codes = [...answer.description.matchAll(/`(\w+)`/g)].map((match) => match[1]);
        assert.ok(codes.length > 0, `${where} ${status}: codes in the description`);
        for (const code of codes) {
          assert.ok(isErrorCode(code), `${where} ${status}: ${code} is not registered`);
          assert.equal(String(ERROR_CODES[code].status), status, `${where}: ${code} under ${status}`);
        }
      }
    }
  });

  test("no inline object schemas: bodies and answers are components; parameters are scalars", () => {
    for (const { method, path, op } of operations) {
      const where = `${method} ${path}`;
      for (const media of Object.values(op.requestBody?.content ?? {})) {
        assert.deepEqual(Object.keys(media.schema), ["$ref"], `${where}: request body`);
      }
      for (const [status, answer] of Object.entries(op.responses)) {
        for (const media of Object.values(answer.content ?? {})) {
          assert.deepEqual(Object.keys(media.schema), ["$ref"], `${where} ${status}`);
        }
      }
      for (const parameter of op.parameters ?? []) {
        assert.equal(parameter.schema?.type, "string", `${where}: parameter ${parameter.name}`);
      }
    }
  });

  test("API §1.3: every optional property of a request component is nullable (omitted or null)", () => {
    const schemas = (doc.components as { schemas: Record<string, Json> }).schemas;
    const requests = CONTRACT_COMPONENTS.filter((component) => component.direction === "request");
    let checked = 0;
    for (const { id } of requests) {
      const schema = schemas[id] as { properties?: Record<string, Json>; required?: string[] };
      const required = new Set(schema.required ?? []);
      for (const [name, property] of Object.entries(schema.properties ?? {})) {
        if (required.has(name)) continue;
        checked += 1;
        assert.equal(property.nullable, true, `${id}.${name}: ${JSON.stringify(property)}`);
      }
    }
    assert.ok(checked > 10);
  });

  test("components are exactly the contract; every $ref resolves; no additionalProperties: false", () => {
    const schemas = (doc.components as { schemas: Json }).schemas;
    assert.deepEqual(Object.keys(schemas), CONTRACT_COMPONENTS.map((component) => component.id).sort());
    for (const name of ["PlaybackSummary", "SystemConnectedPayload", "SyncChangedPayload", "LinkUpdatedPayload"]) {
      assert.ok(Object.hasOwn(schemas, name), name);
    }
    for (const ref of refsIn(doc)) {
      assert.ok(ref.startsWith("#/components/schemas/"), ref);
      assert.ok(Object.hasOwn(schemas, ref.slice("#/components/schemas/".length)), `${ref} does not resolve`);
    }
    assert.ok(!generated.json.includes('"additionalProperties": false'));
    assert.deepEqual(Object.keys((doc.components as { securitySchemes: Json }).securitySchemes), ["bearerAuth"]);
  });
});
