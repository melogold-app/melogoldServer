/**
 * The CLI stub and `main.ts`: `help`/`version` work, an unknown command is a usage error, and the CLI path never
 * loads Fastify (DESIGN §6.3: "CLI не импортирует fastify").
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { EXIT_USAGE, runCli } from "./index.ts";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, output: { out: (text: string) => out.push(text), err: (text: string) => err.push(text) } };
}

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

describe("CLI", () => {
  test("help and usage errors", async () => {
    const help = capture();
    assert.equal(await runCli(["help"], help.output), 0);
    assert.match(help.out.join(""), /Usage: melogold <command>/);
    assert.match(help.out.join(""), /sync rotate-epoch/);

    const unknown = capture();
    assert.equal(await runCli(["user", "add", "maxim"], unknown.output), EXIT_USAGE);
    assert.match(unknown.err.join(""), /"user add maxim" is not available/);
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
