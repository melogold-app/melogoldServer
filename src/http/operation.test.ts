/**
 * `operation()` (API §1.1, §3): the error statuses of each route follow its policy, 204 has no body, the rate limits
 * of API §1.10 appear in the description.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { z } from "zod";
import { ErrorResponse } from "../contract/common.ts";
import { errorCodesByStatus, EVENT_STREAM, operation, operationErrorCodes, rateLimitText } from "./operation.ts";
import { ROUTE_TABLE, resolveRoutePolicy } from "./route-policy.ts";

const Body = z.object({ a: z.string() });
const Answer = z.object({ ok: z.boolean() });

describe("operation()", () => {
  test("codes implied by the policy: public GET, Bearer POST with a body, X-Sync-Protocol, storage", () => {
    assert.deepEqual(operationErrorCodes("GET", "/health/live", { database: false }), ["internal_error"]);
    assert.deepEqual(operationErrorCodes("GET", "/server/info", {}), [
      "rate_limited",
      "internal_error",
      "server_busy",
      "unavailable",
    ]);
    assert.deepEqual(operationErrorCodes("POST", "/auth/me/links", {}), [
      "invalid_request",
      "invalid_json",
      "unauthorized",
      "access_token_invalid",
      "access_token_expired",
      "session_revoked",
      "payload_too_large",
      "unsupported_media_type",
      "rate_limited",
      "internal_error",
      "server_busy",
      "unavailable",
    ]);
    const sync = operationErrorCodes("POST", "/sync", { errors: ["cursor_invalid"] });
    for (const code of ["protocol_unsupported", "storage_full", "cursor_invalid"] as const)
      assert.ok(sync.includes(code));
    assert.ok(!operationErrorCodes("GET", "/sync/summary", {}).includes("storage_full"));
    assert.ok(
      !operationErrorCodes("POST", "/auth/logout", { errors: ["not_implemented"] }).includes("not_implemented"),
    );
  });

  test("statuses group their codes", () => {
    assert.deepEqual(errorCodesByStatus(["invalid_request", "unauthorized", "session_revoked", "server_busy"]), {
      "400": ["invalid_request"],
      "401": ["unauthorized", "session_revoked"],
      "503": ["server_busy"],
    });
  });

  test("the schema carries the success response, one ErrorResponse per error status and the security", () => {
    const schema = operation("POST", "/auth/login", {
      operationId: "login",
      tag: "auth",
      summary: "Sign in",
      body: Body,
      status: 200,
      response: Answer,
      errors: ["invalid_credentials"],
    });
    assert.equal(schema.operationId, "login");
    assert.deepEqual(schema.tags, ["auth"]);
    assert.deepEqual(schema.security, []);
    assert.equal(schema.body, Body);
    const response = schema.response as Record<string, unknown>;
    assert.equal(response["200"], Answer);
    for (const status of ["400", "401", "413", "415", "429", "500", "503"])
      assert.equal(response[status], ErrorResponse);
    assert.deepEqual(schema.errorCodes?.["401"], ["invalid_credentials"]);
    assert.equal(schema.description, "Rate limit: 60/10 min per IP (IPv6 by /56) (API §1.10).");

    const bearer = operation("GET", "/auth/me", {
      operationId: "getMe",
      tag: "auth",
      summary: "Me",
      status: 200,
      response: Answer,
    });
    assert.deepEqual(bearer.security, [{ bearerAuth: [] }]);
  });

  test("204 has no body; SSE is described by its media type", () => {
    const logout = operation("POST", "/auth/logout", {
      operationId: "logout",
      tag: "auth",
      summary: "Out",
      status: 204,
    });
    assert.equal((logout.response as Record<string, z.ZodType>)["204"]?.safeParse(undefined).success, true);
    assert.throws(() =>
      operation("POST", "/auth/logout", {
        operationId: "logout",
        tag: "auth",
        summary: "Out",
        status: 204,
        response: Answer,
      }),
    );
    assert.throws(() =>
      operation("GET", "/auth/me", { operationId: "getMe", tag: "auth", summary: "Me", status: 200 }),
    );
    const events = operation("GET", "/auth/me/events", {
      operationId: "streamEvents",
      tag: "live",
      summary: "SSE",
      status: 200,
      response: Answer,
      contentType: EVENT_STREAM,
    });
    assert.deepEqual((events.response as Record<string, unknown>)["200"], {
      content: { "text/event-stream": { schema: Answer } },
    });
  });

  test("rate limit texts for every row of API §1.10", () => {
    const texts = Object.keys(ROUTE_TABLE).map((key) => {
      const space = key.indexOf(" ");
      return rateLimitText(resolveRoutePolicy(key.slice(0, space), key.slice(space + 1)).rateLimits);
    });
    assert.ok(texts.includes("Rate limit: 60/min per poll secret and 600/min per IP (IPv6 by /56) (API §1.10)."));
    assert.ok(texts.includes("Rate limit: 30/hour per IP (IPv6 by /56) (API §1.10)."));
    assert.ok(texts.includes("Rate limit: 5/hour per user (API §1.10)."));
    assert.ok(texts.includes(null));
  });
});
