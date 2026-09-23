/**
 * The registry equals API §2: every code of the §2.2 table with its status and details, the op result codes of §2.3,
 * and the detail keys of `ErrorResponse` (§2.1). The tables are read from `docs/API.md`, so a contract change that
 * forgets the code (or the other way round) fails here.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  ALL_ERROR_CODES,
  CLIENT_LOCAL_OP_CODES,
  ERROR_CODES,
  ERROR_DETAIL_KEYS,
  OP_RESULT_CODES,
  isErrorCode,
} from "./error-codes.ts";

const API = readFileSync(new URL("../../docs/API.md", import.meta.url), "utf8");

function section(start: string, end: string): string {
  const from = API.indexOf(start);
  const to = API.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `section ${start} not found in docs/API.md`);
  return API.slice(from, to);
}

function tableRows(text: string): string[][] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("|") && !/^\|\s*-/.test(line))
    .map((line) =>
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    )
    .slice(1); // header
}

function backticked(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "");
}

type Expected = { status: number; required: string[]; optional: string[] };

function expectedFromApi(): Map<string, Expected> {
  const expected = new Map<string, Expected>();
  for (const [status = "", codesCell = "", detailsCell = ""] of tableRows(section("### 2.2", "### 2.3"))) {
    const codes = backticked(codesCell);
    const detailGroups = codesCell.includes(" / ")
      ? detailsCell.split(" / ").map((group) => backticked(group))
      : codes.map(() => backticked(detailsCell));
    codes.forEach((code, index) => {
      const details = detailGroups[index] ?? [];
      expected.set(code, {
        status: Number(status),
        required: details.filter((key) => !key.endsWith("?")).sort(),
        optional: details
          .filter((key) => key.endsWith("?"))
          .map((key) => key.slice(0, -1))
          .sort(),
      });
    });
  }
  return expected;
}

describe("error code registry (API §2.2)", () => {
  const expected = expectedFromApi();

  test("the table was parsed", () => {
    assert.ok(expected.size >= 45, `only ${expected.size} codes parsed`);
    assert.deepEqual(expected.get("device_limit_reached"), {
      status: 409,
      required: ["deviceCount", "deviceLimit"],
      optional: [],
    });
    assert.deepEqual(expected.get("password_too_long"), { status: 400, required: ["maxLength"], optional: [] });
    assert.deepEqual(expected.get("unavailable"), { status: 503, required: [], optional: ["retryAfterSeconds"] });
  });

  test("same codes in the same order", () => {
    assert.deepEqual(ALL_ERROR_CODES, [...expected.keys()]);
  });

  test("same status and details for every code", () => {
    for (const [code, spec] of Object.entries(ERROR_CODES)) {
      assert.deepEqual(
        { status: spec.status, required: [...spec.required].sort(), optional: [...spec.optional].sort() },
        expected.get(code),
        code,
      );
    }
  });

  test("codes are snake_case, messages are non-empty English", () => {
    for (const [code, spec] of Object.entries(ERROR_CODES)) {
      assert.match(code, /^[a-z][a-z0-9_]*$/);
      assert.match(spec.message, /^[A-Z][\x20-\x7e]*$/, code);
    }
    assert.equal(isErrorCode("login_taken"), true);
    assert.equal(isErrorCode("toString"), false);
    assert.equal(isErrorCode(42), false);
  });

  test("detail keys are those of ErrorResponse (API §2.1)", () => {
    const block = section("type ErrorResponse", "};");
    const keys = [...block.matchAll(/(\w+)\??:\s*[\w[\]]+/g)]
      .map((match) => match[1] ?? "")
      .filter((key) => !["statusCode", "error", "message", "code"].includes(key));
    assert.deepEqual([...ERROR_DETAIL_KEYS].sort(), [...new Set(keys)].sort());
  });

  test("every detail used by a code is a known detail key", () => {
    for (const spec of Object.values(ERROR_CODES)) {
      for (const key of [...spec.required, ...spec.optional]) assert.ok(ERROR_DETAIL_KEYS.includes(key), key);
    }
  });
});

describe("op result codes (API §2.3)", () => {
  test("same codes and statuses as the table", () => {
    const rows = tableRows(section("### 2.3", "### 2.4"));
    const server = new Map<string, string>();
    const local: string[] = [];
    for (const [codesCell = "", statusCell = ""] of rows) {
      const codes = backticked(codesCell);
      if (statusCell.includes("только локально")) {
        local.push(...codes);
        continue;
      }
      const status = backticked(statusCell)[0] ?? "";
      for (const code of codes) server.set(code, status);
    }
    assert.deepEqual(
      Object.fromEntries(Object.entries(OP_RESULT_CODES).map(([code, spec]) => [code, spec.status])),
      Object.fromEntries(server),
    );
    assert.deepEqual([...CLIENT_LOCAL_OP_CODES], local);
  });
});
