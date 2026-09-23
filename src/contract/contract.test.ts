/**
 * The contract in code equals the contract in `docs/API.md`. The TypeScript declarations of API §2.1, §4, §6 and §11
 * and the payload column of the §6 table are parsed from the document and compared with the zod schemas:
 *
 * - every named type is a component with the same name, and every component is a named type (or one of the
 *   objects API.md writes inline, `CONTRACT_NAMED_INLINE_OBJECTS`);
 * - same keys; `?` ⇔ optional; `| null` ⇔ nullable (a `?` request field also accepts `null`, API §1.3);
 * - same types: strings, integers, booleans, arrays, references to the same component, inline objects recursively;
 * - responses never use `enum` (API §1.3), no object is inline (API §1.1).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { z } from "zod";
import { CONTRACT_COMPONENTS, CONTRACT_NAMED_INLINE_OBJECTS, componentId } from "./index.ts";
import type { ComponentDirection } from "./index.ts";

const API = readFileSync(new URL("../../docs/API.md", import.meta.url), "utf8");

function section(start: string, end: string): string {
  const from = API.indexOf(start);
  const to = end === "" ? API.length : API.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `section ${start} not found in docs/API.md`);
  return API.slice(from, to);
}

// ---------------------------------------------------------------------------------------------------------------------
// A small parser for the type declarations of API.md
// ---------------------------------------------------------------------------------------------------------------------

type ApiType =
  | Readonly<{ kind: "prim"; name: "string" | "number" | "boolean" | "object" }>
  | Readonly<{ kind: "ref"; name: string }>
  | Readonly<{ kind: "array"; element: ApiType }>
  | Readonly<{ kind: "inline"; fields: ApiObject }>;

/** `type: null` for the untyped fields of the §6 payload column (`{heartbeatMs, retryMs}`). */
type ApiField = Readonly<{ optional: boolean; nullable: boolean; type: ApiType | null }>;
type ApiObject = ReadonlyMap<string, ApiField>;

const STRING_ALIASES = new Set(["string", "Iso", "Uuid", "VideoId", "BrowseId", "Cursor"]);
const OPEN = "{[(";
const CLOSE = "}])";

/** Splits at top-level separators, outside brackets and string literals. */
function splitTop(text: string, separators: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (const char of text) {
    if (quote !== null) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (OPEN.includes(char)) {
      depth += 1;
    } else if (CLOSE.includes(char)) {
      depth -= 1;
    } else if (depth === 0 && separators.includes(char)) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

function parseObject(text: string): ApiObject {
  const inner = text.trim();
  assert.ok(inner.startsWith("{") && inner.endsWith("}"), `not an object type: ${inner}`);
  const fields = new Map<string, ApiField>();
  for (const member of splitTop(inner.slice(1, -1), ";,")) {
    const match = /^(\w+)(\?)?\s*(?::\s*([\s\S]+))?$/.exec(member);
    assert.ok(match, `cannot parse member "${member}"`);
    const [, name = "", optional, typeText] = match;
    if (typeText === undefined) {
      fields.set(name, { optional: optional === "?", nullable: false, type: null });
      continue;
    }
    const arms = splitTop(typeText, "|");
    const nonNull = arms.filter((arm) => arm !== "null");
    fields.set(name, { optional: optional === "?", nullable: nonNull.length < arms.length, type: parseType(nonNull) });
  }
  return fields;
}

function parseType(arms: readonly string[]): ApiType {
  if (arms.length > 1) {
    assert.ok(
      arms.every((arm) => /^"[^"]*"$/.test(arm)),
      `API has no polymorphism, got ${arms.join(" | ")}`,
    );
    return { kind: "prim", name: "string" };
  }
  const arm = arms[0] ?? "";
  if (arm.endsWith("[]")) return { kind: "array", element: parseType([arm.slice(0, -2)]) };
  if (arm.startsWith("{")) return { kind: "inline", fields: parseObject(arm) };
  if (STRING_ALIASES.has(arm) || /^"[^"]*"$/.test(arm)) return { kind: "prim", name: "string" };
  if (arm === "number" || /^\d+$/.test(arm)) return { kind: "prim", name: "number" };
  if (arm === "boolean" || arm === "true" || arm === "false") return { kind: "prim", name: "boolean" };
  if (arm === "object") return { kind: "prim", name: "object" };
  assert.match(arm, /^[A-Z]\w*$/, `unknown type "${arm}"`);
  return { kind: "ref", name: arm };
}

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Object types declared as `type Name = {…};` in the ```ts blocks of `text`. */
function declaredObjects(text: string): Map<string, ApiObject> {
  const result = new Map<string, ApiObject>();
  for (const block of text.matchAll(/```ts\n([\s\S]*?)```/g)) {
    const code = stripComments(block[1] ?? "");
    for (const statement of splitTop(code, ";")) {
      const match = /^type\s+(\w+)\s*=\s*([\s\S]+)$/.exec(statement);
      assert.ok(match, `cannot parse statement "${statement.slice(0, 60)}"`);
      const [, name = "", body = ""] = match;
      if (!body.startsWith("{")) continue; // `type Iso = string` and other aliases
      assert.ok(!result.has(name), `${name} is declared twice`);
      result.set(name, parseObject(body));
    }
  }
  return result;
}

/** `XxxPayload {a, b: T | null}` from the table of API §6 (`\|` is an escaped pipe). */
function payloadObjects(text: string): Map<string, ApiObject> {
  const result = new Map<string, ApiObject>();
  const tableLines = text
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .join("\n");
  for (const span of tableLines.matchAll(/`([^`]+)`/g)) {
    const match = /^(\w+Payload) (\{[\s\S]*\})$/.exec((span[1] ?? "").replaceAll("\\|", "|"));
    if (match) result.set(match[1] ?? "", parseObject(match[2] ?? ""));
  }
  return result;
}

function apiObjects(): Map<string, ApiObject> {
  const all = new Map<string, ApiObject>();
  const sources = [
    declaredObjects(section("### 2.1", "### 2.2")),
    declaredObjects(section("## 4. ", "## 5. ")),
    declaredObjects(section("## 6. ", "## 7. ")),
    payloadObjects(section("## 6. ", "## 7. ")),
    declaredObjects(section("## 11. ", "")),
  ];
  for (const source of sources) {
    for (const [name, object] of source) {
      assert.ok(!all.has(name), `${name} is declared twice in API.md`);
      all.set(name, object);
    }
  }
  return all;
}

// ---------------------------------------------------------------------------------------------------------------------
// zod side
// ---------------------------------------------------------------------------------------------------------------------

type AnySchema = z.core.$ZodType;
type Unwrapped = Readonly<{ base: AnySchema; optional: boolean; nullable: boolean }>;

type WrapperDef = { type: string; innerType?: AnySchema; in?: AnySchema; element?: AnySchema; shape?: object };

function def(schema: AnySchema): WrapperDef {
  return schema._zod.def;
}

/** Peels optional/nullable/pipe (the input side: requests) wrappers. */
function unwrap(schema: AnySchema): Unwrapped {
  let current = schema;
  let optional = false;
  let nullable = false;
  for (;;) {
    const d = def(current);
    if (d.type === "optional" && d.innerType) {
      optional = true;
      current = d.innerType;
    } else if (d.type === "nullable" && d.innerType) {
      nullable = true;
      current = d.innerType;
    } else if ((d.type === "default" || d.type === "catch" || d.type === "readonly") && d.innerType) {
      current = d.innerType;
    } else if (d.type === "pipe" && d.in) {
      current = d.in;
    } else {
      return { base: current, optional, nullable };
    }
  }
}

function shapeOf(schema: AnySchema, where: string): Record<string, AnySchema> {
  const d = def(schema);
  assert.equal(d.type, "object", `${where}: expected an object schema`);
  return d.shape as Record<string, AnySchema>;
}

function idOf(schema: AnySchema): string | null {
  return componentId(schema as z.ZodType);
}

const DIRECTION = new Map(CONTRACT_COMPONENTS.map((c) => [c.id, c.direction]));
const SCHEMA = new Map(CONTRACT_COMPONENTS.map((c) => [c.id, c.schema as AnySchema]));
const NAMED_INLINE = new Set(CONTRACT_NAMED_INLINE_OBJECTS);

function compareType(
  where: string,
  type: ApiType,
  base: AnySchema,
  direction: ComponentDirection,
  inline: Set<string>,
): void {
  const baseType = def(base).type;
  switch (type.kind) {
    case "prim":
      if (type.name === "string") {
        const allowed = direction === "request" ? ["string", "enum"] : ["string"];
        assert.ok(allowed.includes(baseType), `${where}: expected ${allowed.join("|")}, got ${baseType}`);
      } else if (type.name === "number") {
        assert.equal(baseType, "number", `${where}: expected a number`);
        assert.equal((base as z.ZodType).safeParse(1.5).success, false, `${where}: numbers are integers (API §1.4)`);
      } else {
        assert.equal(baseType, type.name, `${where}: expected ${type.name}`);
      }
      return;
    case "ref":
      assert.equal(idOf(base), type.name, `${where}: expected a reference to ${type.name}`);
      return;
    case "array": {
      assert.equal(baseType, "array", `${where}: expected an array`);
      const element = unwrap(def(base).element!);
      assert.ok(!element.optional && !element.nullable, `${where}: array items are never null`);
      compareType(`${where}[]`, type.element, element.base, direction, inline);
      return;
    }
    case "inline": {
      const id = idOf(base);
      assert.ok(id !== null && NAMED_INLINE.has(id), `${where}: inline object must be a named component, got ${id}`);
      inline.add(id);
      compareObject(`${where}<${id}>`, type.fields, base, direction, inline);
      return;
    }
  }
}

function compareObject(
  where: string,
  api: ApiObject,
  schema: AnySchema,
  direction: ComponentDirection,
  inline: Set<string>,
): void {
  const shape = shapeOf(schema, where);
  assert.deepEqual(Object.keys(shape).sort(), [...api.keys()].sort(), `${where}: keys differ from API.md`);
  for (const [key, field] of api) {
    const at = `${where}.${key}`;
    const zodField = unwrap(shape[key]!);
    const lenient = def(zodField.base).type === "unknown";
    if (lenient) assert.ok(where === "TrackInput", `${at}: only TrackInput metadata is parsed leniently`);
    assert.equal(zodField.optional, field.optional, `${at}: optional must be ${field.optional}`);
    if (!lenient) {
      const nullable = field.nullable || (direction === "request" && field.optional);
      assert.equal(zodField.nullable, nullable, `${at}: nullable must be ${nullable}`);
      if (field.type !== null) compareType(at, field.type, zodField.base, direction, inline);
    }
  }
}

/** Finds nested objects without a component name (API §1.1: no inline schemas). */
function unnamedObjects(schema: AnySchema, where: string, root: boolean, found: string[]): void {
  const d = def(schema);
  if (!root && idOf(schema) !== null) return; // a reference
  switch (d.type) {
    case "object": {
      if (!root && where !== "LiveEvent.payload") found.push(where);
      for (const [key, child] of Object.entries(d.shape as Record<string, AnySchema>)) {
        unnamedObjects(child, `${where}.${key}`, false, found);
      }
      return;
    }
    case "array":
      unnamedObjects(d.element!, `${where}[]`, false, found);
      return;
    case "pipe":
      unnamedObjects(d.in!, where, false, found);
      return;
    default:
      if (d.innerType) unnamedObjects(d.innerType, where, false, found);
  }
}

/** Object schemas with properties below the root of a rendered JSON schema (free-form `{}` objects excluded). */
function nestedObjectSchemas(node: unknown, root: boolean): unknown[] {
  if (typeof node !== "object" || node === null) return [];
  const found: unknown[] = [];
  const properties = (node as { properties?: unknown }).properties;
  if (!root && typeof properties === "object" && properties !== null && Object.keys(properties).length > 0) {
    found.push(node);
  }
  for (const child of Object.values(node)) found.push(...nestedObjectSchemas(child, false));
  return found;
}

// ---------------------------------------------------------------------------------------------------------------------

const API_OBJECTS = apiObjects();

describe("contract components (API §1.1, §4, §6, §11)", () => {
  test("API.md was parsed", () => {
    for (const name of ["TrackDto", "ServerInfo", "SyncOp", "LinkPollResponse", "ServerLimits", "ErrorResponse"]) {
      assert.ok(API_OBJECTS.has(name), name);
    }
    assert.equal([...API_OBJECTS.keys()].filter((name) => name.endsWith("Payload")).length, 7);
  });

  test("every component once; components = API types + named inline objects", () => {
    const ids = CONTRACT_COMPONENTS.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length, "duplicate component ids");
    const expected = new Set([...API_OBJECTS.keys(), ...CONTRACT_NAMED_INLINE_OBJECTS]);
    assert.deepEqual([...new Set(ids)].sort(), [...expected].sort());
    for (const name of CONTRACT_NAMED_INLINE_OBJECTS) assert.ok(!API_OBJECTS.has(name), `${name} is named in API.md`);
  });

  test("every schema registered with an id is a component (and every *Payload is registered)", () => {
    const registered = [...z.globalRegistry._idmap.keys()].sort();
    assert.deepEqual(registered, CONTRACT_COMPONENTS.map((c) => c.id).sort());
    for (const name of API_OBJECTS.keys()) if (name.endsWith("Payload")) assert.ok(registered.includes(name), name);
  });

  test("keys, optionality, nullability and types equal API.md", () => {
    const inline = new Set<string>();
    for (const [name, api] of API_OBJECTS) {
      const schema = SCHEMA.get(name);
      const direction = DIRECTION.get(name);
      assert.ok(schema && direction, `${name} is not a component`);
      compareObject(name, api, schema, direction, inline);
    }
    // Every named inline object replaces an inline object of API.md (EmptyRequest replaces an unnamed `{}` body).
    assert.deepEqual([...inline, "EmptyRequest"].sort(), [...CONTRACT_NAMED_INLINE_OBJECTS].sort());
  });

  test("no inline objects inside components", () => {
    const found: string[] = [];
    for (const c of CONTRACT_COMPONENTS) unnamedObjects(c.schema, c.id, true, found);
    assert.deepEqual(found, []);
  });

  test("requests render as input, responses as output, each without the other's components", () => {
    const uri = (id: string) => `#/components/schemas/${id}`;
    const render = (direction: ComponentDirection) => {
      const registry = new z.core.$ZodRegistry<{ id?: string }>();
      for (const c of CONTRACT_COMPONENTS) if (c.direction === direction) registry.add(c.schema, { id: c.id });
      const io = direction === "request" ? "input" : "output";
      return z.toJSONSchema(registry, { target: "openapi-3.0", io, unrepresentable: "throw", uri }).schemas;
    };
    const rendered = { request: render("request"), response: render("response") };
    for (const c of CONTRACT_COMPONENTS) {
      const schema = rendered[c.direction][c.id];
      assert.ok(schema, c.id);
      // A nested object of the other direction would be inlined: API §1.1 forbids it.
      assert.deepEqual(nestedObjectSchemas(schema, true), [], `${c.id}: nested inline object`);
      const json = JSON.stringify(schema);
      if (c.direction === "response") assert.ok(!json.includes('"enum"'), `${c.id}: enum in a response`);
    }
  });
});
