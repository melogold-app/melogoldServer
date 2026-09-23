/** `spec/error-codes.json` equals the registry of the code (DESIGN §10) and carries its license (DESIGN §12). */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { errorCodesDocument, errorCodesJson } from "../../../scripts/gen-error-codes.ts";
import { ALL_ERROR_CODES, OP_RESULT_CODES } from "../../http/error-codes.ts";

const committed = readFileSync(new URL("../../../spec/error-codes.json", import.meta.url), "utf8");

describe("spec/error-codes.json", () => {
  test("is generated from src/http/error-codes.ts (npm run openapi)", () => {
    assert.equal(committed, errorCodesJson(), "spec/error-codes.json is stale: run npm run openapi");
  });

  test("lists every HTTP code and op result code, CC0-1.0", () => {
    const document = errorCodesDocument();
    assert.equal(document.license, "CC0-1.0");
    assert.deepEqual(
      document.errors.map((entry) => entry.code),
      [...ALL_ERROR_CODES],
    );
    assert.deepEqual(
      document.opResults.map((entry) => entry.code),
      Object.keys(OP_RESULT_CODES),
    );
    assert.deepEqual(document.clientLocalOpCodes, ["client_bug", "server_error"]);
    assert.deepEqual(
      document.opResults.find((entry) => entry.code === "op_rate_limited"),
      { code: "op_rate_limited", status: "deferred", details: ["retryAfterSeconds"] },
    );
    const deviceLimit = document.errors.find((entry) => entry.code === "device_limit_reached");
    assert.deepEqual(deviceLimit, {
      code: "device_limit_reached",
      status: 409,
      message: "Device limit reached",
      details: { required: ["deviceLimit", "deviceCount"], optional: [] },
    });
  });
});
