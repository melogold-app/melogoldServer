/** The image's HEALTHCHECK (DESIGN §7.1): loopback for wildcard addresses, 200 → healthy, anything else → not. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";
import { checkHealth, probeHost } from "./healthcheck.ts";

async function serve(status: number, delayMs = 0): Promise<{ port: number; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    setTimeout(() => {
      response.statusCode = request.url === "/health" ? status : 404;
      response.end("{}");
    }, delayMs);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

describe("healthcheck", () => {
  test("probe host", () => {
    assert.equal(probeHost("0.0.0.0"), "127.0.0.1");
    assert.equal(probeHost("::"), "::1");
    assert.equal(probeHost("[::1]"), "::1");
    assert.equal(probeHost("127.0.0.1"), "127.0.0.1");
  });

  test("200 is healthy; 503, a timeout and a closed port are not", async () => {
    const ok = await serve(200);
    const down = await serve(503);
    const slow = await serve(200, 500);
    try {
      assert.equal(await checkHealth("127.0.0.1", ok.port), true);
      assert.equal(await checkHealth("0.0.0.0", ok.port), true);
      assert.equal(await checkHealth("127.0.0.1", down.port), false);
      assert.equal(await checkHealth("127.0.0.1", slow.port, 100), false);
    } finally {
      await Promise.all([ok.close(), down.close(), slow.close()]);
    }
    assert.equal(await checkHealth("127.0.0.1", ok.port, 1000), false);
  });
});
