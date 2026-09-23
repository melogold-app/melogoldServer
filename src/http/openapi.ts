/**
 * The OpenAPI 3.0.3 document (API §1.1) from the routes and the contract, through `@fastify/swagger`:
 *
 * - every schema of `CONTRACT_COMPONENTS` is emitted once under its own name in `components.schemas`: requests as the
 *   client sends them (zod `io: "input"`), responses as the server sends them (`io: "output"`); no inline object
 *   schemas (API §1.1). `additionalProperties: false` is dropped: requests ignore unknown keys and responses may gain
 *   fields within `apiVersion: 1` (API §1.1, §1.3);
 * - every operation is built by `operation()` (`operation.ts`): `operationId`, a tag, `security`, the body and path
 *   parameters, the success response, one `ErrorResponse` per error status with its codes in the description, and
 *   `X-Sync-Protocol` as a required header where API §1.2 asks for it;
 * - routes without a tag (`GET /`, `GET /openapi.json`, `/docs`, CORS preflight) are left out;
 * - paths follow the order of API §3 (`ROUTE_TABLE`), so the document does not depend on registration order.
 *
 * The same document is served at `GET /openapi.json` and committed as `openapi/openapi.json` and `openapi.yaml`
 * (`npm run openapi`, `scripts/gen-openapi.ts`). The contract files are CC0-1.0 (DESIGN §12, question 2).
 */
import fastifySwagger from "@fastify/swagger";
import type { FastifyInstance, FastifySchema } from "fastify";
import { z } from "zod";
import { CONTRACT_COMPONENTS, componentId } from "../contract/index.ts";
import type { ComponentDirection } from "../contract/index.ts";
import { API_VERSION } from "../lib/protocol.ts";
import { ERROR_CODES } from "./error-codes.ts";
import type { ErrorCode } from "./error-codes.ts";
import { BEARER_SECURITY_SCHEME, OPENAPI_TAGS } from "./operation.ts";
import { resolveRoutePolicy, ROUTE_TABLE, routeKey } from "./route-policy.ts";
import { SYNC_PROTOCOL_PATTERN } from "./sync-protocol.ts";

export const OPENAPI_VERSION = "3.0.3";
export const CONTRACT_LICENSE = Object.freeze({
  name: "CC0-1.0",
  url: "https://creativecommons.org/publicdomain/zero/1.0/",
});

type JsonSchema = Record<string, unknown>;

const COMPONENT_PREFIX = "#/components/schemas/";
const componentUri = (id: string): string => `${COMPONENT_PREFIX}${id}`;

/** Keys that zod may emit but OpenAPI 3.0 does not know (or that only identify the root). */
const DROPPED_KEYWORDS = new Set([
  "$id",
  "$schema",
  "unevaluatedProperties",
  "dependentSchemas",
  "patternProperties",
  "propertyNames",
  "contentEncoding",
  "contentMediaType",
]);
/** Positions that hold subschemas. `properties` holds a map of them. */
const SINGLE_SCHEMA_KEYWORDS = new Set(["items", "additionalProperties", "not"]);
const SCHEMA_LIST_KEYWORDS = new Set(["allOf", "anyOf", "oneOf"]);

/** The `type` of each component, to give a nullable reference its type (OpenAPI 3.0 needs it next to `nullable`). */
type ComponentTypes = ReadonlyMap<string, string>;

function refTarget(schema: JsonSchema): string | null {
  const ref = schema.$ref;
  return typeof ref === "string" && ref.startsWith(COMPONENT_PREFIX) ? ref.slice(COMPONENT_PREFIX.length) : null;
}

/**
 * A reference wrapped by zod in a one-element `allOf`:
 * - without siblings (an optional reference) it becomes the plain `$ref`;
 * - `nullable: true` gets the `type` of the component: OpenAPI 3.0.3 applies `nullable` only with a `type` in the
 *   same schema object (and Redocly's `nullable-type-sibling` requires it).
 */
function simplifyReference(schema: JsonSchema, types: ComponentTypes): JsonSchema {
  const allOf = schema.allOf;
  if (!Array.isArray(allOf) || allOf.length !== 1) return schema;
  const [only] = allOf as unknown[];
  if (typeof only !== "object" || only === null) return schema;
  const target = refTarget(only as JsonSchema);
  if (target === null) return schema;
  const siblings = Object.keys(schema).filter((key) => key !== "allOf");
  if (siblings.length === 0) return only as JsonSchema;
  if (schema.nullable === true && schema.type === undefined) {
    const type = types.get(target);
    if (type !== undefined) return { type, ...schema };
  }
  return schema;
}

/**
 * Removes {@link DROPPED_KEYWORDS} and `additionalProperties: false`, simplifies wrapped references, walking only
 * schema positions.
 */
export function sanitizeSchema(value: unknown, types: ComponentTypes = new Map()): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeSchema(item, types));
  if (typeof value !== "object" || value === null) return value;
  const result: JsonSchema = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (DROPPED_KEYWORDS.has(key)) continue;
    if (key === "additionalProperties" && child === false) continue;
    if (key === "properties" && typeof child === "object" && child !== null) {
      const properties = Object.entries(child as Record<string, unknown>);
      result[key] = Object.fromEntries(properties.map(([name, item]) => [name, sanitizeSchema(item, types)]));
    } else if (SINGLE_SCHEMA_KEYWORDS.has(key) || SCHEMA_LIST_KEYWORDS.has(key)) {
      result[key] = sanitizeSchema(child, types);
    } else {
      result[key] = child;
    }
  }
  return simplifyReference(result, types);
}

function renderRegistry(direction: ComponentDirection): Record<string, JsonSchema> {
  const registry = new z.core.$ZodRegistry<{ id?: string }>();
  for (const component of CONTRACT_COMPONENTS) {
    if (component.direction === direction) registry.add(component.schema, { id: component.id });
  }
  const io = direction === "request" ? "input" : "output";
  const { schemas } = z.toJSONSchema(registry, {
    target: "openapi-3.0",
    io,
    unrepresentable: "throw",
    uri: componentUri,
  });
  return schemas;
}

/** `components.schemas`: every contract component once, sorted by name. */
export function renderComponents(): Record<string, JsonSchema> {
  const rendered = { ...renderRegistry("request"), ...renderRegistry("response") };
  const types = new Map<string, string>();
  for (const [id, schema] of Object.entries(rendered)) {
    if (typeof schema.type === "string") types.set(id, schema.type);
  }
  const sorted: Record<string, JsonSchema> = {};
  for (const id of Object.keys(rendered).sort()) sorted[id] = sanitizeSchema(rendered[id], types) as JsonSchema;
  return sorted;
}

function isZodSchema(value: unknown): value is z.ZodType {
  return value instanceof z.ZodType;
}

/** A route-level schema: a `$ref` for a component, an inline rendering otherwise (path parameters). */
function schemaJson(schema: unknown, io: "input" | "output"): unknown {
  if (!isZodSchema(schema)) return schema;
  const id = componentId(schema);
  if (id !== null) return { $ref: componentUri(id) };
  return sanitizeSchema(z.toJSONSchema(schema, { target: "openapi-3.0", io, unrepresentable: "throw" }));
}

function errorDescription(codes: readonly ErrorCode[]): string {
  return codes
    .map((code) => {
      const spec = ERROR_CODES[code];
      const details = [...spec.required, ...spec.optional.map((key) => `${key}?`)];
      return `\`${code}\`${details.length > 0 ? ` (${details.join(", ")})` : ""}`;
    })
    .join(", ");
}

const SUCCESS_DESCRIPTIONS: Readonly<Record<string, string>> = { "200": "OK", "201": "Created", "204": "No Content" };

function responseJson(status: string, schema: unknown, errorCodes: readonly ErrorCode[] | undefined): unknown {
  if (errorCodes !== undefined) {
    return { ...(schemaJson(schema, "output") as JsonSchema), description: errorDescription(errorCodes) };
  }
  const description = SUCCESS_DESCRIPTIONS[status] ?? "Success";
  if (status === "204") return { type: "null", description };
  if (typeof schema === "object" && schema !== null && "content" in schema) {
    const content: Record<string, unknown> = {};
    for (const [mediaType, entry] of Object.entries(
      (schema as { content: Record<string, { schema: unknown }> }).content,
    )) {
      content[mediaType] = { schema: schemaJson(entry.schema, "output") };
    }
    return { description, content };
  }
  return { ...(schemaJson(schema, "output") as JsonSchema), description };
}

const SYNC_PROTOCOL_HEADER_SCHEMA = {
  type: "object",
  properties: {
    "X-Sync-Protocol": {
      type: "string",
      pattern: SYNC_PROTOCOL_PATTERN.source,
      description:
        "Sync protocol of the client, within [features.sync.minProtocol, features.sync.protocol] (API §1.2). Missing or not an integer → 400 invalid_request; outside → 409 protocol_unsupported.",
    },
  },
  required: ["X-Sync-Protocol"],
};

/** `@fastify/swagger` `transform`: zod route schemas → the JSON the plugin turns into an operation. */
export function transformRoute({
  schema,
  url,
  route,
}: {
  schema: FastifySchema | undefined;
  url: string;
  route: { method: string | string[] };
}): { schema: FastifySchema; url: string } {
  if (schema?.operationId === undefined || schema.tags === undefined) return { schema: { hide: true }, url };
  const method = Array.isArray(route.method) ? (route.method[0] ?? "GET") : route.method;
  const { body, documentedBody, params, response, errorCodes, ...rest } = schema;
  const transformed: FastifySchema = { ...rest };
  const requestBody = documentedBody ?? body;
  if (requestBody !== undefined) transformed.body = schemaJson(requestBody, "input");
  if (params !== undefined) transformed.params = schemaJson(params, "input");
  if (resolveRoutePolicy(method, url).syncProtocol) transformed.headers = SYNC_PROTOCOL_HEADER_SCHEMA;
  if (typeof response === "object" && response !== null) {
    const responses: Record<string, unknown> = {};
    for (const [status, statusSchema] of Object.entries(response)) {
      responses[status] = responseJson(status, statusSchema, errorCodes?.[status]);
    }
    transformed.response = responses;
  }
  return { schema: transformed, url };
}

const PATH_ORDER: ReadonlyMap<string, number> = new Map(
  Object.keys(ROUTE_TABLE).map((key, index) => {
    const path = key.slice(key.indexOf(" ") + 1).replace(/:(\w+)/g, "{$1}");
    return [path, index];
  }),
);

function pathRank(path: string): number {
  return PATH_ORDER.get(path) ?? Number.MAX_SAFE_INTEGER;
}

/** The fixed part of the document (everything except paths and schemas). */
export function openapiBase(): Record<string, unknown> {
  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: "Melogold API",
      version: String(API_VERSION),
      description:
        "Sync server of Melogold: favorites, library, playlists, history and playback across a user's devices. " +
        "The normative contract is docs/API.md; clients branch only on `code` of ErrorResponse (error-codes.json). " +
        "There is no version in the URL: compatibility comes from `apiVersion`/`minApiVersion` and " +
        "`features.sync.protocol` of `GET /server/info` (API §1.1).",
      license: { ...CONTRACT_LICENSE },
    },
    servers: [
      {
        url: "https://api.melogold.app",
        description: "The official server. Self-hosted servers serve the same API under their own base URL.",
      },
    ],
    tags: OPENAPI_TAGS.map((tag) => ({ ...tag })),
    components: {
      securitySchemes: {
        [BEARER_SECURITY_SCHEME]: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "Access token of TokenPair (API §1.7).",
        },
      },
    },
  };
}

/** `@fastify/swagger` `transformObject`: components, the order of paths, no empty keys. */
export function transformDocument(document: Record<string, unknown>): Record<string, unknown> {
  const paths = (document.paths ?? {}) as Record<string, unknown>;
  const orderedPaths: Record<string, unknown> = {};
  for (const path of Object.keys(paths).sort((a, b) => pathRank(a) - pathRank(b) || a.localeCompare(b))) {
    orderedPaths[path] = paths[path];
  }
  const base = openapiBase();
  return {
    openapi: base.openapi,
    info: base.info,
    servers: base.servers,
    tags: base.tags,
    paths: orderedPaths,
    components: {
      ...(base.components as Record<string, unknown>),
      schemas: renderComponents(),
    },
  };
}

/** Registers `@fastify/swagger` (before any route: it collects routes in `onRoute`). */
export async function registerOpenapi(app: FastifyInstance): Promise<void> {
  await app.register(fastifySwagger, {
    openapi: openapiBase(),
    hideUntagged: true,
    transform: ({ schema, url, route }) => transformRoute({ schema, url, route }),
    transformObject: (documentObject) =>
      "openapiObject" in documentObject
        ? transformDocument(documentObject.openapiObject as Record<string, unknown>)
        : documentObject.swaggerObject,
  });
}

/** The key of a documented operation in {@link ROUTE_TABLE} form (`GET /auth/me/devices/:`). */
export function operationKey(method: string, openapiPath: string): string {
  return routeKey(method, openapiPath.replace(/\{(\w+)\}/g, ":$1"));
}
