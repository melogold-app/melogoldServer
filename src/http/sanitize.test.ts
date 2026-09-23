import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { sanitizeJson } from "./sanitize.ts";

describe("sanitizeJson (API §1.4, M12)", () => {
  test("every string at any depth: NUL removed, lone surrogates replaced", () => {
    const body = JSON.parse(
      '{"login":"ma\\u0000xim","device":{"name":"Pixel\\ud800","tags":["a\\u0000","\\udc00b",{"deep":"x\\u0000y"}]},"n":1,"ok":true,"nil":null}',
    ) as unknown;
    const result = sanitizeJson(body);
    assert.equal(result, body, "sanitized in place");
    assert.deepEqual(body, {
      login: "maxim",
      device: { name: "Pixel�", tags: ["a", "�b", { deep: "xy" }] },
      n: 1,
      ok: true,
      nil: null,
    });
  });

  test("property names too; the later duplicate wins", () => {
    const body = JSON.parse('{"a\\u0000b":1,"c\\ud800":2,"ab":3}') as Record<string, unknown>;
    sanitizeJson(body);
    assert.deepEqual(body, { "c�": 2, ab: 3 });
  });

  test("__proto__ stays an ordinary property", () => {
    const body = JSON.parse('{"__proto__\\u0000":{"polluted":true}}') as Record<string, unknown>;
    sanitizeJson(body);
    assert.equal(Object.getPrototypeOf(body), Object.prototype);
    assert.deepEqual(Object.keys(body), ["__proto__"]);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });

  test("top-level values and clean input", () => {
    assert.equal(sanitizeJson("a\u0000"), "a");
    assert.equal(sanitizeJson(5), 5);
    assert.equal(sanitizeJson(null), null);
    const clean = { a: ["b", { c: "d" }] };
    assert.deepEqual(sanitizeJson(structuredClone(clean)), clean);
  });

  test("deep nesting does not overflow the stack", () => {
    let body: unknown = "x\u0000";
    for (let i = 0; i < 200_000; i++) body = [body];
    sanitizeJson(body);
    let inner: unknown = body;
    while (Array.isArray(inner)) inner = inner[0] as unknown;
    assert.equal(inner, "x");
  });
});
