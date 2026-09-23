import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DAY_MS, ManualClock } from "../lib/clock.ts";
import {
  REDACTED,
  REQUEST_ID_PATTERN,
  createIpTagger,
  isSecretKey,
  loggerOptions,
  maskSecrets,
  requestIdFrom,
  serializeRequest,
} from "./logging.ts";

describe("maskSecrets (DESIGN §9, m13)", () => {
  test("masks the listed keys at any depth, keeps the error code", () => {
    const masked = maskSecrets({
      headers: { authorization: "Bearer x", cookie: "a=b", "user-agent": "melogold-android/1.3.0" },
      body: {
        login: "maxim",
        password: "p",
        currentPassword: "p",
        newPassword: "p",
        device: { hwid: "abc", name: "Pixel" },
        pow: { challenge: "c", nonce: "1" },
        items: [{ refreshToken: "r" }, { accessToken: "a" }],
      },
      recoveryCode: "X",
      pollSecret: "mgps_x",
      linkToken: "t",
      userCode: "ABCD-EFGH",
      code: "invalid_password",
    });
    assert.deepEqual(masked, {
      headers: { authorization: REDACTED, cookie: REDACTED, "user-agent": "melogold-android/1.3.0" },
      body: {
        login: "maxim",
        password: REDACTED,
        currentPassword: REDACTED,
        newPassword: REDACTED,
        device: { hwid: REDACTED, name: "Pixel" },
        pow: REDACTED,
        items: [{ refreshToken: REDACTED }, { accessToken: REDACTED }],
      },
      recoveryCode: REDACTED,
      pollSecret: REDACTED,
      linkToken: REDACTED,
      userCode: REDACTED,
      code: "invalid_password",
    });
  });

  test("case-insensitive; anything containing password", () => {
    assert.equal(isSecretKey("Authorization"), true);
    assert.equal(isSecretKey("oldPasswordHash"), true);
    assert.equal(isSecretKey("REFRESHTOKEN"), true);
    assert.equal(isSecretKey("code"), false);
    assert.equal(isSecretKey("deviceId"), false);
  });

  test("does not mutate the input; handles cycles, depth and non-plain objects", () => {
    const input: Record<string, unknown> = { password: "p" };
    maskSecrets(input);
    assert.equal(input.password, "p");
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    assert.deepEqual(maskSecrets(cyclic), { a: 1, self: "[circular]" });
    let deep: unknown = { password: "p" };
    for (let i = 0; i < 20; i++) deep = { next: deep };
    assert.doesNotThrow(() => JSON.stringify(maskSecrets(deep)));
    const error = new Error("boom");
    assert.equal((maskSecrets({ err: error }) as { err: unknown }).err, error, "errors are left to the serializer");
  });

  test("the logger masks through formatters.log", () => {
    const options = loggerOptions({ LOG_LEVEL: "info" });
    const format = options.formatters?.log;
    assert.ok(format);
    assert.deepEqual(format({ body: { password: "p" } }), { body: { password: REDACTED } });
    assert.equal(options.level, "info");
  });
});

describe("serializeRequest", () => {
  test("route template, or the path without the query; never the address", () => {
    assert.deepEqual(
      serializeRequest({
        method: "PATCH",
        url: "/auth/me/devices/9b1e?x=1",
        routeOptions: { url: "/auth/me/devices/:deviceId" },
        ip: "203.0.113.9",
      }),
      { method: "PATCH", url: "/auth/me/devices/:deviceId" },
    );
    assert.deepEqual(serializeRequest({ method: "GET", url: "/nope?token=secret" }), { method: "GET", url: "/nope" });
    assert.deepEqual(serializeRequest(undefined), { method: "", url: "" });
  });
});

describe("X-Request-Id (API §1.2)", () => {
  test("a valid client id is kept, anything else replaced by a UUID", () => {
    assert.equal(requestIdFrom("abcDEF12._-"), "abcDEF12._-");
    assert.equal(requestIdFrom("x".repeat(64)), "x".repeat(64));
    for (const bad of [undefined, "short", "x".repeat(65), "has space 123", "ÿÿÿÿÿÿÿÿ", ["a", "b"]]) {
      const id = requestIdFrom(bad);
      assert.match(id, /^[0-9a-f-]{36}$/);
      assert.match(id, REQUEST_ID_PATTERN);
    }
  });
});

describe("ipTag (m16)", () => {
  test("12 hex, stable within a UTC day, different the next day and for another address", () => {
    const clock = new ManualClock(Date.UTC(2026, 8, 23, 23, 59, 0));
    const tag = createIpTagger(clock);
    const first = tag("203.0.113.9");
    assert.match(first, /^[0-9a-f]{12}$/);
    assert.equal(tag("203.0.113.9"), first);
    assert.notEqual(tag("203.0.113.10"), first);
    clock.advance(2 * 60_000);
    assert.notEqual(tag("203.0.113.9"), first, "the key changed at 00:00 UTC");
    clock.advance(DAY_MS - 5 * 60_000);
    const sameDay = tag("203.0.113.9");
    assert.equal(tag("203.0.113.9"), sameDay);
    assert.doesNotMatch(first, /203/);
  });

  test("the key comes only from memory: two taggers disagree", () => {
    const clock = new ManualClock(0);
    assert.notEqual(createIpTagger(clock)("192.0.2.1"), createIpTagger(clock)("192.0.2.1"));
  });
});
