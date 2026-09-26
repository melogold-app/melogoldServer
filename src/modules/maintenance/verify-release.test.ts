/**
 * minisign signatures (PLAN T3.1 `verify-release.test`): the vectors of `spec/vectors/minisign`, made by the real
 * tool, verify in both formats; a changed file, a changed trusted comment and another key are refused; `SHA256SUMS`
 * lines check the files they name.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  RELEASE_PUBLIC_KEY,
  ReleaseSignatureError,
  parseChecksums,
  parsePublicKey,
  verifyChecksums,
  verifyMinisign,
} from "./verify-release.ts";

const VECTORS = new URL("../../../spec/vectors/minisign/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, VECTORS));
const text = (name: string) => read(name).toString("utf8");

const PUBLIC_KEY = text("test.pub");

function refused(run: () => unknown, message: RegExp): void {
  assert.throws(run, (error: unknown) => error instanceof ReleaseSignatureError && message.test(error.message));
}

describe("verify-release", () => {
  test("the prehashed signature of minisign verifies and returns its trusted comment", () => {
    assert.equal(
      verifyMinisign(PUBLIC_KEY, text("SHA256SUMS.minisig"), read("SHA256SUMS")),
      "timestamp:1790000000\tfile:SHA256SUMS\thashed",
    );
  });

  test("the legacy signature verifies too, and the key line alone is enough", () => {
    const keyLine = PUBLIC_KEY.split("\n")[1] ?? "";
    assert.equal(
      verifyMinisign(keyLine, text("SHA256SUMS.legacy.minisig"), read("SHA256SUMS.legacy")),
      "timestamp:1790000000\tfile:SHA256SUMS.legacy",
    );
  });

  test("a changed file, a changed trusted comment or another key is refused", () => {
    const tampered = Buffer.concat([read("SHA256SUMS"), Buffer.from("\n")]);
    refused(() => verifyMinisign(PUBLIC_KEY, text("SHA256SUMS.minisig"), tampered), /does not match the file/);

    const comment = text("SHA256SUMS.minisig").replace("timestamp:1790000000", "timestamp:1790000001");
    refused(() => verifyMinisign(PUBLIC_KEY, comment, read("SHA256SUMS")), /trusted comment was altered/);

    const key = Buffer.from(PUBLIC_KEY.split("\n")[1] ?? "", "base64");
    key[2] = (key[2] ?? 0) ^ 0xff;
    refused(
      () => verifyMinisign(key.toString("base64"), text("SHA256SUMS.minisig"), read("SHA256SUMS")),
      /made with another key/,
    );

    refused(() => parsePublicKey("untrusted comment: x\nnot base64!"), /not base64/);
    refused(() => verifyMinisign(PUBLIC_KEY, "garbage", read("SHA256SUMS")), /untrusted comment/);
  });

  test("SHA256SUMS lines check the files they name", () => {
    const sums = parseChecksums(text("SHA256SUMS"));
    assert.deepEqual([...sums.keys()], ["empty.txt", "install.sh"]);
    verifyChecksums(sums, [{ name: "empty.txt", bytes: Buffer.alloc(0) }]);
    refused(() => verifyChecksums(sums, [{ name: "install.sh", bytes: Buffer.from("#!/bin/sh\n") }]), /does not match/);
    refused(() => verifyChecksums(sums, [{ name: "other.tar.gz", bytes: Buffer.alloc(0) }]), /not in SHA256SUMS/);
    refused(() => parseChecksums("abc  file"), /not a SHA256SUMS line/);
  });

  test("the release key compiled into the image is a minisign Ed25519 key", () => {
    assert.ok(RELEASE_PUBLIC_KEY !== null);
    assert.equal(parsePublicKey(RELEASE_PUBLIC_KEY).keyId.toString("hex"), "6f555f83c314ab30");
  });
});
