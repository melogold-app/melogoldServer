/** `AppError` and the pure error mapping of API §2 (`toErrorReply`). */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { z } from "zod";
import { SemaphoreFullError } from "../lib/semaphore.ts";
import { ERROR_CODES } from "./error-codes.ts";
import type { ErrorCode } from "./error-codes.ts";
import { MAX_VALIDATION_ISSUES, errorReply, toErrorReply } from "./error-handler.ts";
import { AppError, isAppError } from "./errors.ts";

const ENVELOPE = ["statusCode", "error", "message", "code"];

function fastifyError(code: string, statusCode: number, extra: object = {}): Error {
  return Object.assign(new Error(code), { code, statusCode, ...extra });
}

describe("AppError", () => {
  test("status and default message from the registry", () => {
    const error = new AppError("login_taken");
    assert.equal(error.statusCode, 409);
    assert.equal(error.code, "login_taken");
    assert.equal(error.message, "Login is taken");
    assert.deepEqual(error.details, {});
    assert.ok(isAppError(error));
    assert.ok(error instanceof Error);
    assert.equal(isAppError(new Error("x")), false);
  });

  test("typed details, custom message, headers, cause", () => {
    const cause = new Error("inner");
    const error = new AppError("device_limit_reached", {
      details: { deviceLimit: 20, deviceCount: 20 },
      message: "Device limit reached for user",
      headers: { "x-extra": "1" },
      cause,
    });
    assert.deepEqual(error.details, { deviceLimit: 20, deviceCount: 20 });
    assert.equal(error.cause, cause);
    assert.deepEqual(error.headers, { "x-extra": "1" });
  });

  test("codes with required details cannot be thrown without them (compile time)", () => {
    // @ts-expect-error -- device_limit_reached requires deviceLimit and deviceCount
    const missing = new AppError("device_limit_reached");
    // @ts-expect-error -- rate_limited requires retryAfterSeconds
    const wrong = new AppError("rate_limited", { details: { deviceLimit: 1 } });
    assert.ok(missing instanceof AppError && wrong instanceof AppError);
    // @ts-expect-error -- not a registry code; at run time too
    assert.throws(() => new AppError("teapot"), TypeError);
    assert.throws(() => new AppError("toString" as ErrorCode), TypeError);
    // `unavailable` has only an optional detail.
    assert.equal(new AppError("unavailable").statusCode, 503);
  });
});

describe("errorReply: the envelope of API §2.1", () => {
  test("every code: 4 keys, error = message, never 200", () => {
    for (const code of Object.keys(ERROR_CODES) as ErrorCode[]) {
      const reply = errorReply(code);
      assert.ok(reply.statusCode >= 400, code);
      assert.deepEqual(Object.keys(reply.body).slice(0, 4), ENVELOPE, code);
      assert.equal(reply.body.error, reply.body.message);
      assert.equal(reply.body.code, code);
      assert.equal(reply.body.statusCode, reply.statusCode);
    }
  });

  test("the example of API §2.1", () => {
    const reply = errorReply("device_limit_reached", { details: { deviceLimit: 20, deviceCount: 20 } });
    assert.equal(
      JSON.stringify(reply.body),
      '{"statusCode":409,"error":"Device limit reached","message":"Device limit reached","code":"device_limit_reached","deviceLimit":20,"deviceCount":20}',
    );
  });

  test("details not allowed for the code are dropped", () => {
    const reply = errorReply("login_taken", { details: { retryAfterSeconds: 5, deviceLimit: 1 } });
    assert.deepEqual(Object.keys(reply.body), ENVELOPE);
  });

  test("5xx always carry the generic message; 4xx keep a custom one", () => {
    assert.equal(
      errorReply("internal_error", { message: "db password is hunter2" }).body.message,
      "Internal server error",
    );
    assert.equal(errorReply("server_busy", { message: "pool" }).body.message, "Server is busy");
    assert.equal(errorReply("login_taken", { message: "Login maxim is taken" }).body.message, "Login maxim is taken");
  });

  test("Retry-After on 429 and 503 with retryAfterSeconds", () => {
    assert.equal(errorReply("rate_limited", { details: { retryAfterSeconds: 7 } }).headers["retry-after"], "7");
    assert.equal(errorReply("server_busy", { details: { retryAfterSeconds: 2 } }).headers["retry-after"], "2");
    assert.equal(errorReply("unavailable").headers["retry-after"], undefined);
    assert.equal(errorReply("login_throttled", { details: { retryAfterSeconds: 30 } }).body.retryAfterSeconds, 30);
  });

  test("log level: bugs error, 503 warn, stubs and 4xx none", () => {
    assert.equal(errorReply("internal_error").log, "error");
    assert.equal(errorReply("not_implemented").log, "none");
    assert.equal(errorReply("storage_full", { details: { retryAfterSeconds: 600 } }).log, "warn");
    assert.equal(errorReply("unauthorized").log, "none");
  });
});

describe("toErrorReply", () => {
  test("AppError", () => {
    const reply = toErrorReply(new AppError("cursor_expired", { details: { floorCursor: "0a1b2c3d.0.0" } }));
    assert.equal(reply.statusCode, 410);
    assert.equal(reply.body.floorCursor, "0a1b2c3d.0.0");
  });

  test("route schema validation (zod provider shape) → invalid_request with issues", () => {
    const error = fastifyError("FST_ERR_VALIDATION", 400, {
      validationContext: "body",
      validation: [
        { instancePath: "/ops/3/opId", keyword: "invalid_format" },
        { instancePath: "/ops/0/n", keyword: "too_big" },
      ],
    });
    const reply = toErrorReply(error);
    assert.equal(reply.statusCode, 400);
    assert.equal(reply.body.code, "invalid_request");
    assert.deepEqual(reply.body.issues, [
      { path: "ops.3.opId", code: "invalid_format" },
      { path: "ops.0.n", code: "too_big" },
    ]);
  });

  test("params, querystring and headers issues are prefixed with their part", () => {
    const params = toErrorReply(
      fastifyError("FST_ERR_VALIDATION", 400, {
        validationContext: "params",
        validation: [{ instancePath: "/deviceId", keyword: "invalid_format" }],
      }),
    );
    assert.deepEqual(params.body.issues, [{ path: "params.deviceId", code: "invalid_format" }]);
    const root = toErrorReply(
      fastifyError("FST_ERR_VALIDATION", 400, { validationContext: "body", validation: [{ instancePath: "/" }] }),
    );
    assert.deepEqual(root.body.issues, [{ path: "", code: "invalid" }]);
  });

  test("issues are capped", () => {
    const validation = Array.from({ length: 500 }, (_, index) => ({ instancePath: `/ops/${index}`, keyword: "x" }));
    const reply = toErrorReply(fastifyError("FST_ERR_VALIDATION", 400, { validationContext: "body", validation }));
    assert.equal(reply.body.issues?.length, MAX_VALIDATION_ISSUES);
  });

  test("ZodError thrown by code → invalid_request", () => {
    const result = z.object({ a: z.number().int().max(2_147_483_647) }).safeParse({ a: 2 ** 31 });
    assert.equal(result.success, false);
    const reply = toErrorReply(result.error);
    assert.equal(reply.body.code, "invalid_request");
    assert.deepEqual(reply.body.issues, [{ path: "a", code: "too_big" }]);
  });

  test("Fastify body errors", () => {
    assert.equal(toErrorReply(fastifyError("FST_ERR_CTP_EMPTY_JSON_BODY", 400)).body.code, "invalid_json");
    assert.equal(toErrorReply(fastifyError("FST_ERR_CTP_INVALID_JSON_BODY", 400)).body.code, "invalid_json");
    assert.equal(toErrorReply(fastifyError("FST_ERR_CTP_BODY_TOO_LARGE", 413)).body.code, "payload_too_large");
    assert.equal(toErrorReply(fastifyError("FST_ERR_CTP_INVALID_MEDIA_TYPE", 415)).body.code, "unsupported_media_type");
    assert.equal(toErrorReply(fastifyError("FST_ERR_NOT_FOUND", 404)).body.code, "not_found");
    const other = toErrorReply(fastifyError("FST_ERR_CTP_INVALID_CONTENT_LENGTH", 400));
    assert.equal(other.body.code, "invalid_request");
    assert.deepEqual(other.body.issues, []);
    assert.equal(toErrorReply(fastifyError("SOME_PLUGIN", 418)).statusCode, 400);
    assert.equal(toErrorReply(fastifyError("SOME_PLUGIN", 429)).body.retryAfterSeconds, 60);
  });

  test("full argon2 queue → 503 server_busy{5}", () => {
    const reply = toErrorReply(new SemaphoreFullError());
    assert.equal(reply.body.code, "server_busy");
    assert.equal(reply.body.retryAfterSeconds, 5);
    assert.equal(reply.headers["retry-after"], "5");
  });

  test("database conditions (API §2.4)", () => {
    const busy = toErrorReply(Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }), () => 0.9);
    assert.equal(busy.body.code, "server_busy");
    assert.equal(busy.headers["retry-after"], "2");
    const down = toErrorReply(Object.assign(new Error("terminating"), { code: "57P01" }));
    assert.equal(down.body.code, "unavailable");
    assert.equal(down.body.retryAfterSeconds, 5);
    const full = toErrorReply(Object.assign(new Error("disk full"), { code: "SQLITE_FULL" }));
    assert.equal(full.body.code, "storage_full");
    assert.equal(full.headers["retry-after"], "600");
  });

  test("untranslated constraint violations, bugs and non-errors → 500 with the generic message", () => {
    for (const error of [
      Object.assign(new Error("UNIQUE constraint failed: users.login"), { code: "SQLITE_CONSTRAINT_UNIQUE" }),
      Object.assign(new Error('duplicate key value violates unique constraint "users_login_key"'), { code: "23505" }),
      Object.assign(new Error("invalid byte sequence"), { code: "22021" }),
      new TypeError("x is undefined"),
      "a string",
      null,
      Object.assign(new Error("Response doesn't match the schema"), {
        code: "FST_ERR_RESPONSE_SERIALIZATION",
        statusCode: 500,
        method: "GET",
        url: "/x",
      }),
    ]) {
      const reply = toErrorReply(error);
      assert.equal(reply.statusCode, 500);
      assert.equal(reply.body.code, "internal_error");
      assert.equal(reply.body.message, "Internal server error");
      assert.equal(reply.log, "error");
    }
  });
});
