/**
 * `melogold verify-release` with the minisign vectors: the signature and the listed files are checked; a tampered
 * file fails; an image without a release key refuses.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseEnv } from "../config/env.ts";
import { captureOutput } from "../test/cli-output.ts";
import { EXIT_FAILURE, runCli } from "./index.ts";

const VECTORS = fileURLToPath(new URL("../../spec/vectors/minisign/", import.meta.url));
const env = parseEnv({ NODE_ENV: "test" });
const publicKey = readFileSync(join(VECTORS, "test.pub"), "utf8");
let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "melogold-release-"));
  writeFileSync(join(dir, "empty.txt"), "");
  writeFileSync(join(dir, "install.sh"), "#!/bin/sh\necho tampered\n");
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** `withKey: false` runs like an image that has no release key compiled in. */
async function cli(args: readonly string[], withKey = true) {
  const captured = captureOutput();
  const code = await runCli(args, captured.output, { env, ...(withKey ? { releasePublicKey: publicKey } : {}) });
  return { code, stdout: captured.stdout(), stderr: captured.stderr() };
}

describe("melogold verify-release", () => {
  test("checks the signature and the files it lists", async () => {
    const ok = await cli([
      "verify-release",
      join(VECTORS, "SHA256SUMS"),
      join(VECTORS, "SHA256SUMS.minisig"),
      join(dir, "empty.txt"),
    ]);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(ok.stdout, "signature ok: timestamp:1790000000\tfile:SHA256SUMS\thashed\nok empty.txt\n");
  });

  test("a file that does not match its line fails", async () => {
    const bad = await cli([
      "verify-release",
      join(VECTORS, "SHA256SUMS"),
      join(VECTORS, "SHA256SUMS.minisig"),
      join(dir, "install.sh"),
    ]);
    assert.equal(bad.code, EXIT_FAILURE);
    assert.match(bad.stderr, /install\.sh does not match its SHA256SUMS line/);
  });

  test("the image without a release key refuses", async () => {
    const none = await cli(["verify-release", join(VECTORS, "SHA256SUMS"), join(VECTORS, "SHA256SUMS.minisig")], false);
    assert.equal(none.code, EXIT_FAILURE);
    assert.match(none.stderr, /no release key/);
  });
});
