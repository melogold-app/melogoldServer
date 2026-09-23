/** Client address, JSON content type, `X-Sync-Protocol` and the disk guard. */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isJsonContentType, requiresJsonBody } from "./body-rules.ts";
import { clientNet, isSecureTransport, sameNetwork, trustProxyOption } from "./client-ip.ts";
import { STORAGE_FULL_RETRY_AFTER_SECONDS, createDiskGuard } from "./disk-guard.ts";
import type { DiskSpace } from "./disk-guard.ts";
import { AppError } from "./errors.ts";
import { checkSyncProtocol } from "./sync-protocol.ts";

describe("client network (API §1.10)", () => {
  test("IPv4 whole, IPv6 /56, mapped IPv4 as IPv4", () => {
    assert.equal(clientNet("203.0.113.9"), "203.0.113.9");
    assert.equal(clientNet("2001:db8:1234:5678::1"), "2001:db8:1234:5600::");
    assert.equal(clientNet("2001:DB8:1234:56ff:ffff::1"), "2001:db8:1234:5600::");
    assert.equal(clientNet("::ffff:198.51.100.7"), "198.51.100.7");
    assert.equal(sameNetwork("2001:db8:1234:5601::1", "2001:db8:1234:56aa::2"), true);
    assert.equal(sameNetwork("2001:db8:1234:5701::1", "2001:db8:1234:56aa::2"), false);
    assert.equal(sameNetwork("203.0.113.9", "203.0.113.10"), false);
  });

  test("TRUST_PROXY: empty trusts nobody, otherwise the CIDR list", () => {
    assert.equal(trustProxyOption([]), false);
    assert.deepEqual(trustProxyOption(["127.0.0.1/32", "::1/128"]), ["127.0.0.1/32", "::1/128"]);
  });

  test("secure transport follows the (proxied) protocol", () => {
    assert.equal(isSecureTransport({ protocol: "https" }), true);
    assert.equal(isSecureTransport({ protocol: "http" }), false);
  });
});

describe("JSON content type (API §1.2)", () => {
  test("application/json, UTF-8 only", () => {
    assert.equal(isJsonContentType("application/json"), true);
    assert.equal(isJsonContentType("Application/JSON; charset=UTF-8"), true);
    assert.equal(isJsonContentType('application/json; charset="utf-8"'), true);
    assert.equal(isJsonContentType("application/json;charset=iso-8859-1"), false);
    assert.equal(isJsonContentType("text/plain"), false);
    assert.equal(isJsonContentType("application/json-patch+json"), false);
    assert.equal(isJsonContentType("multipart/form-data; boundary=x"), false);
    assert.equal(isJsonContentType(undefined), false);
    assert.equal(isJsonContentType(""), false);
  });

  test("POST, PUT and PATCH carry a body", () => {
    assert.equal(requiresJsonBody("post"), true);
    assert.equal(requiresJsonBody("PATCH"), true);
    assert.equal(requiresJsonBody("GET"), false);
    assert.equal(requiresJsonBody("DELETE"), false);
  });
});

describe("X-Sync-Protocol (API §1.2)", () => {
  test("1 is supported", () => {
    assert.equal(checkSyncProtocol("1"), null);
  });

  test("missing or not an integer → 400 invalid_request", () => {
    for (const value of [undefined, "", "1.0", "+1", "one", " 1", "1, 1", ["1", "1"], "1".repeat(10)]) {
      const error = checkSyncProtocol(value);
      assert.ok(error instanceof AppError, String(value));
      assert.equal(error.code, "invalid_request");
      assert.equal(error.details.issues?.[0]?.path, "headers.x-sync-protocol");
    }
  });

  test("outside [min, max] → 409 protocol_unsupported with the range", () => {
    for (const value of ["0", "2", "999999999"]) {
      const error = checkSyncProtocol(value);
      assert.equal(error?.code, "protocol_unsupported");
      assert.deepEqual(error.details, { minProtocol: 1, maxProtocol: 1 });
    }
  });
});

describe("disk guard (DESIGN §3.10)", () => {
  function fakeDisk(space: { value: DiskSpace | Error }) {
    return (path: string) => {
      assert.equal(path, "/data");
      return space.value instanceof Error ? Promise.reject(space.value) : Promise.resolve(space.value);
    };
  }

  test("storage_full below the threshold, recovery above it", async () => {
    const space: { value: DiskSpace | Error } = { value: { bavail: 50, blocks: 100 } };
    const logs: string[] = [];
    const guard = createDiskGuard({
      path: "/data",
      minFreePercent: 10,
      statfs: fakeDisk(space),
      now: () => 42,
      log: { warn: (_d, message) => logs.push(`warn ${message}`), info: (_d, message) => logs.push(`info ${message}`) },
    });
    assert.equal(guard.status(), null);
    assert.equal(guard.isFull(), false, "unknown is not full");
    assert.deepEqual(await guard.check(), { freePercent: 50, full: false, checkedAt: 42 });
    guard.assertWritable();

    space.value = { bavail: 9n, blocks: 100n };
    await guard.check();
    assert.equal(guard.isFull(), true);
    assert.throws(
      () => {
        guard.assertWritable();
      },
      (error: unknown) =>
        error instanceof AppError &&
        error.code === "storage_full" &&
        error.details.retryAfterSeconds === STORAGE_FULL_RETRY_AFTER_SECONDS,
    );
    await guard.check();
    assert.equal(logs.filter((line) => line.startsWith("warn")).length, 1, "the transition is logged once");

    space.value = new Error("EIO");
    await guard.check();
    assert.equal(guard.isFull(), true, "an error keeps the last state");

    space.value = { bavail: 10, blocks: 100 };
    await guard.check();
    assert.equal(guard.isFull(), false);
    assert.ok(logs.includes("info disk space recovered"));
  });

  test("start/stop with the real statfs of an existing directory", async () => {
    const guard = createDiskGuard({ path: process.cwd(), minFreePercent: 1 });
    guard.start(60_000);
    guard.start(60_000);
    await guard.check();
    guard.stop();
    const status = guard.status();
    assert.ok(status);
    assert.ok(status.freePercent >= 0 && status.freePercent <= 100);
  });
});
