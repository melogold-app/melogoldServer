/** `spec/hwid.vectors.json` (API §1.6 `Hwid`, DESIGN §4.6): the same for every client. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { HWID_PATTERN } from "../../contract/common.ts";
import { computeHwid, hwidHash } from "./hwid.ts";

type Vectors = {
  license: string;
  vectors: { platform: string; platformId: string; serverId: string; hwid: string }[];
};

const VECTORS = JSON.parse(
  readFileSync(new URL("../../../spec/hwid.vectors.json", import.meta.url), "utf8"),
) as Vectors;

describe("spec/hwid.vectors.json", () => {
  test("is CC0 and covers every platform and the fallback", () => {
    assert.equal(VECTORS.license, "CC0-1.0");
    assert.deepEqual(
      VECTORS.vectors.map((vector) => vector.platform),
      ["android", "macos", "windows", "linux", "fallback"],
    );
  });

  test('hwid = hex(sha256("melogold-hwid-v1|" + platformId + "|" + serverId)), a valid Hwid', () => {
    for (const vector of VECTORS.vectors) {
      assert.equal(computeHwid(vector.platformId, vector.serverId), vector.hwid, vector.platform);
      assert.match(vector.hwid, HWID_PATTERN);
    }
  });

  test("another server gives another hwid; the server stores sha256(hwid)", () => {
    const [first] = VECTORS.vectors;
    assert.ok(first);
    assert.notEqual(computeHwid(first.platformId, "00000000-0000-4000-8000-000000000000"), first.hwid);
    assert.match(hwidHash(first.hwid), /^[0-9a-f]{64}$/);
    assert.notEqual(hwidHash(first.hwid), first.hwid);
  });
});
