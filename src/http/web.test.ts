/** CORS by path (API §1.2): `*` only on the discovery routes, `CORS_ORIGINS` elsewhere, off by default. */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { corsOptionsFor, PUBLIC_CORS_PATHS } from "./web.ts";

describe("CORS options", () => {
  test("discovery routes: any origin, no credentials", () => {
    assert.deepEqual([...PUBLIC_CORS_PATHS], ["/server/info", "/health", "/health/live"]);
    for (const path of PUBLIC_CORS_PATHS) {
      const options = corsOptionsFor(path, []);
      assert.equal(options.origin, "*");
      assert.equal(options.credentials, false);
    }
  });

  test("other routes: off without CORS_ORIGINS, the exact list with it", () => {
    assert.deepEqual(corsOptionsFor("/auth/me", []), { origin: false });
    const options = corsOptionsFor("/sync", ["https://web.example.com"]);
    assert.deepEqual(options.origin, ["https://web.example.com"]);
    assert.equal(options.credentials, false);
    assert.ok((options.allowedHeaders as string[]).includes("X-Sync-Protocol"));
    assert.ok((options.exposedHeaders as string[]).includes("Retry-After"));
  });
});
