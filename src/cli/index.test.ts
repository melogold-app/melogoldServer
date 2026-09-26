/**
 * The CLI stub and `main.ts`: `help`/`version` work, an unknown command is a usage error, and the CLI path never
 * loads Fastify (DESIGN §6.3: "CLI не импортирует fastify").
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { captureOutput } from "../test/cli-output.ts";
import { EXIT_USAGE, runCli } from "./index.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

describe("CLI", () => {
  test("help and usage errors", async () => {
    const help = captureOutput();
    assert.equal(await runCli(["help"], help.output), 0);
    assert.match(help.stdout(), /Usage: melogold <command>/);
    assert.match(help.stdout(), /sync rotate-epoch/);
    assert.match(help.stdout(), /user add <login>/);

    const unknown = captureOutput();
    assert.equal(await runCli(["frobnicate", "now"], unknown.output), EXIT_USAGE);
    assert.match(unknown.stderr(), /unknown command "frobnicate now"/);

    const badFlag = captureOutput();
    assert.equal(await runCli(["info", "--jsn"], badFlag.output), EXIT_USAGE);
    assert.match(badFlag.stderr(), /--jsn/);

    const extra = captureOutput();
    assert.equal(await runCli(["migrate", "now"], extra.output), EXIT_USAGE);
    assert.match(extra.stderr(), /unexpected argument "now"/);

    const noJob = captureOutput();
    assert.equal(await runCli(["jobs", "run"], noJob.output), EXIT_USAGE);
    assert.match(noJob.stderr(), /missing job name/);
  });

  test("main() runs the CLI without loading fastify", () => {
    const script = `
      import { registerHooks } from "node:module";
      const seen = [];
      registerHooks({ resolve(specifier, context, next) { seen.push(specifier); return next(specifier, context); } });
      const { main } = await import("./src/main.ts");
      await main(["version"]);
      process.stderr.write(JSON.stringify(seen.filter((s) => s.includes("fastify"))));
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: ROOT,
      encoding: "utf8",
      env: { NODE_ENV: "test", APP_VERSION: "1.2.3", GIT_SHA: "abcdef0" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "melogold-server 1.2.3 (abcdef0)\n");
    assert.equal(result.stderr, "[]");
  });
});
