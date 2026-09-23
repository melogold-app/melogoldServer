import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { NS_MELOGOLD_RECOVERY, UUID_PATTERN, isUuid, newId, recoveryPlaylistId, uuidv5 } from "./ids.ts";

const NAMESPACE_DNS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const NAMESPACE_URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

describe("newId", () => {
  test("lowercase UUID v4, API §1.6", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const id = newId();
      assert.match(id, UUID_PATTERN);
      assert.equal(id[14], "4");
      assert.match(id[19] ?? "", /[89ab]/);
      ids.add(id);
    }
    assert.equal(ids.size, 200);
  });

  test("isUuid accepts lowercase only", () => {
    assert.equal(isUuid("6f1c2c0e-8a3b-4f7e-9c1d-2b5e7a9f0c11"), true);
    assert.equal(isUuid("6F1C2C0E-8A3B-4F7E-9C1D-2B5E7A9F0C11"), false);
    assert.equal(isUuid("6f1c2c0e8a3b4f7e9c1d2b5e7a9f0c11"), false);
    assert.equal(isUuid(42), false);
  });
});

describe("uuidv5 (RFC 9562 §5.5)", () => {
  test("reference vectors (RFC 9562 appendix, Python uuid.uuid5)", () => {
    assert.equal(uuidv5("www.example.com", NAMESPACE_DNS), "2ed6657d-e927-568b-95e1-2665a8aea6a2");
    assert.equal(uuidv5("python.org", NAMESPACE_DNS), "886313e1-3b8a-5372-9b90-0c9aee199e5d");
    assert.equal(uuidv5("https://melogold.app/ü", NAMESPACE_URL), "d60248d5-b3ad-5474-979d-931858356b42");
  });

  test("namespace in any case, result lowercase with version 5 and the RFC variant", () => {
    assert.equal(uuidv5("python.org", NAMESPACE_DNS.toUpperCase()), "886313e1-3b8a-5372-9b90-0c9aee199e5d");
    const id = uuidv5("x", NS_MELOGOLD_RECOVERY);
    assert.match(id, UUID_PATTERN);
    assert.equal(id[14], "5");
    assert.match(id[19] ?? "", /[89ab]/);
    assert.throws(() => uuidv5("x", "not-a-uuid"), TypeError);
  });

  test("recovery playlist id: NS_MELOGOLD_RECOVERY of API §8, deterministic", () => {
    assert.equal(NS_MELOGOLD_RECOVERY, "cf3e0fee-fe4e-42a1-b392-e5ffb8933b87");
    const deleted = "0c3f6a2e-5d1b-4c7a-9e8f-1a2b3c4d5e6f";
    // Python: uuid.uuid5(uuid.UUID("cf3e0fee-fe4e-42a1-b392-e5ffb8933b87"), "0c3f6a2e-5d1b-4c7a-9e8f-1a2b3c4d5e6f")
    assert.equal(recoveryPlaylistId(deleted), "4613014a-8e2a-5131-b098-de5d0eb24a4c");
    assert.equal(recoveryPlaylistId(deleted), recoveryPlaylistId(deleted));
    assert.notEqual(recoveryPlaylistId(deleted), recoveryPlaylistId(newId()));
  });
});
