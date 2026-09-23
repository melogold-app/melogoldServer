import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { isEntryPoint } from "./entry-point.ts";

const HERE = fileURLToPath(import.meta.url);
const NODE = process.execPath;
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

describe("isEntryPoint (instead of import.meta.main, Node 24.2+)", () => {
  test("true only for the script Node was started with, also through a symlink", () => {
    assert.equal(isEntryPoint(import.meta.url, [NODE, HERE]), true);
    assert.equal(
      isEntryPoint(import.meta.url, [NODE, fileURLToPath(new URL("./entry-point.ts", import.meta.url))]),
      false,
    );
    assert.equal(isEntryPoint(import.meta.url, [NODE]), false);
    assert.equal(isEntryPoint(import.meta.url, [NODE, "/nonexistent/script.ts"]), false);
    assert.equal(isEntryPoint("data:text/javascript,0", [NODE, HERE]), false);
    const dir = mkdtempSync(join(tmpdir(), "melogold-entry-"));
    try {
      const link = join(dir, "link.ts");
      symlinkSync(HERE, link);
      assert.equal(isEntryPoint(import.meta.url, [NODE, link]), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("node src/healthcheck.ts runs the probe: a closed port exits 1", () => {
    const result = spawnSync(process.execPath, ["src/healthcheck.ts"], {
      cwd: ROOT,
      env: { HOST: "127.0.0.1", PORT: "1" },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 1, result.stderr);
  });

  test("importing an entry module does not run it", () => {
    const script = `const m = await import(${JSON.stringify(join(ROOT, "src/healthcheck.ts"))}); console.log(typeof m.checkHealth, process.exitCode ?? 0);`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: ROOT,
      env: { HOST: "127.0.0.1", PORT: "1" },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "function 0");
  });
});
