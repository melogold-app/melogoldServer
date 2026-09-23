import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  HKDF_INFO,
  SecretKeyError,
  deriveSubkeys,
  keyFingerprint,
  loadMasterKey,
  rotateKeyFile,
  secretKeyPath,
} from "./secret-key.ts";

const SERVER_ID = "6f1c2c0e-8a3b-4f7e-9c1d-2b5e7a9f0c11";

/** RFC 5869 written out with HMAC, independent of `crypto.hkdfSync`. */
function referenceHkdf(ikm: Buffer, salt: Buffer, info: string, length: number): Buffer {
  const prk = createHmac("sha256", salt).update(ikm).digest();
  const blocks: Buffer[] = [];
  let previous = Buffer.alloc(0);
  for (let counter = 1; blocks.length * 32 < length; counter++) {
    previous = createHmac("sha256", prk)
      .update(Buffer.concat([previous, Buffer.from(info, "utf8"), Buffer.from([counter])]))
      .digest();
    blocks.push(previous);
  }
  return Buffer.concat(blocks).subarray(0, length);
}

describe("loadMasterKey", () => {
  let dataDir: string;
  let warnings: string[];
  const warn = (message: string) => {
    warnings.push(message);
  };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "melogold-secret-"));
    warnings = [];
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("creates secret.key (0600, 64 hex characters) on first start and reuses it afterwards", () => {
    const first = loadMasterKey({ dataDir, envKeyHex: null, warn });
    assert.equal(first.source, "file");
    assert.equal(first.createdFile, true);
    assert.equal(first.file, secretKeyPath(dataDir));
    assert.equal(first.key.length, 32);

    const content = readFileSync(first.file, "utf8");
    assert.match(content, /^[0-9a-f]{64}\n$/);
    assert.equal(content.trim(), first.key.toString("hex"));
    assert.equal(statSync(first.file).mode & 0o777, 0o600);

    const second = loadMasterKey({ dataDir, envKeyHex: null, warn });
    assert.equal(second.createdFile, false);
    assert.deepEqual(second.key, first.key);
    assert.deepEqual(warnings, []);
    assert.deepEqual(readdirSync(dataDir), ["secret.key"], "no temporary files are left behind");
  });

  test("creates a missing DATA_DIR", () => {
    const nested = join(dataDir, "a", "b");
    const key = loadMasterKey({ dataDir: nested, envKeyHex: null, warn });
    assert.equal(key.createdFile, true);
    assert.equal(statSync(nested).isDirectory(), true);
  });

  test("MELOGOLD_SECRET_KEY wins; the file is still created with its own key and the difference is reported", () => {
    const envKey = randomBytes(32);
    const loaded = loadMasterKey({ dataDir, envKeyHex: envKey.toString("hex"), warn });
    assert.equal(loaded.source, "env");
    assert.equal(loaded.createdFile, true);
    assert.deepEqual(loaded.key, envKey);

    const fileContent = readFileSync(secretKeyPath(dataDir), "utf8").trim();
    assert.notEqual(fileContent, envKey.toString("hex"), "the variable is never written to disk");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /MELOGOLD_SECRET_KEY differs/);
    assert.equal(warnings[0]?.includes(envKey.toString("hex")), false, "the warning does not leak the key");
  });

  test("no warning when the variable and the file hold the same key", () => {
    const fileKey = loadMasterKey({ dataDir, envKeyHex: null, warn }).key;
    const loaded = loadMasterKey({ dataDir, envKeyHex: fileKey.toString("hex"), warn });
    assert.equal(loaded.source, "env");
    assert.deepEqual(loaded.key, fileKey);
    assert.deepEqual(warnings, []);
  });

  test("a malformed key file stops the start and is left untouched", () => {
    const file = secretKeyPath(dataDir);
    writeFileSync(file, "not a key\n", { mode: 0o600 });
    assert.throws(() => loadMasterKey({ dataDir, envKeyHex: null, warn }), SecretKeyError);
    assert.equal(readFileSync(file, "utf8"), "not a key\n");
  });

  test("accepts uppercase hex without a trailing newline", () => {
    const key = randomBytes(32);
    writeFileSync(secretKeyPath(dataDir), key.toString("hex").toUpperCase(), { mode: 0o600 });
    assert.deepEqual(loadMasterKey({ dataDir, envKeyHex: null, warn }).key, key);
  });

  test("warns when the key file is readable by other users", () => {
    const { file } = loadMasterKey({ dataDir, envKeyHex: null, warn });
    chmodSync(file, 0o644);
    loadMasterKey({ dataDir, envKeyHex: null, warn });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /0600/);
  });

  test("a directory in place of the key file is an error", () => {
    mkdirSync(secretKeyPath(dataDir));
    assert.throws(() => loadMasterKey({ dataDir, envKeyHex: null, warn }), SecretKeyError);
  });
});

describe("rotateKeyFile", () => {
  test("replaces the key atomically with a new 0600 file", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "melogold-secret-"));
    try {
      const before = loadMasterKey({ dataDir, envKeyHex: null, warn: () => undefined }).key;
      rotateKeyFile(dataDir);
      const after = loadMasterKey({ dataDir, envKeyHex: null, warn: () => undefined });
      assert.equal(after.createdFile, false);
      assert.notDeepEqual(after.key, before);
      assert.equal(statSync(after.file).mode & 0o777, 0o600);
      assert.deepEqual(readdirSync(dataDir), ["secret.key"]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("deriveSubkeys", () => {
  const masterKey = Buffer.from("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "hex");

  test("HKDF-SHA256 with salt = serverId and the info strings of API §8", () => {
    assert.deepEqual(HKDF_INFO, {
      jwtAccess: "melogold/jwt-access/v1",
      refreshToken: "melogold/refresh-token/v1",
      pow: "melogold/pow/v1",
    });
    const subkeys = deriveSubkeys(masterKey, SERVER_ID);
    const salt = Buffer.from(SERVER_ID, "utf8");
    for (const name of ["jwtAccess", "refreshToken", "pow"] as const) {
      assert.equal(subkeys[name].length, 32);
      assert.deepEqual(subkeys[name], referenceHkdf(masterKey, salt, HKDF_INFO[name], 32), name);
    }
  });

  test("subkeys differ per purpose and per server", () => {
    const a = deriveSubkeys(masterKey, SERVER_ID);
    const b = deriveSubkeys(masterKey, "0c3f6a2e-5d1b-4c7a-9e8f-1a2b3c4d5e6f");
    assert.equal(new Set([a.jwtAccess, a.refreshToken, a.pow].map((key) => key.toString("hex"))).size, 3);
    assert.notDeepEqual(a.jwtAccess, b.jwtAccess);
    assert.deepEqual(deriveSubkeys(masterKey, SERVER_ID), a, "deterministic");
  });

  test("rejects a wrong key length and a non-canonical serverId", () => {
    assert.throws(() => deriveSubkeys(Buffer.alloc(16), SERVER_ID), SecretKeyError);
    assert.throws(() => deriveSubkeys(masterKey, SERVER_ID.toUpperCase()), SecretKeyError);
    assert.throws(() => deriveSubkeys(masterKey, "not-a-uuid"), SecretKeyError);
  });

  test("keyFingerprint is short and stable", () => {
    assert.match(keyFingerprint(masterKey), /^[0-9a-f]{8}$/);
    assert.equal(keyFingerprint(masterKey), keyFingerprint(Buffer.from(masterKey)));
  });
});
