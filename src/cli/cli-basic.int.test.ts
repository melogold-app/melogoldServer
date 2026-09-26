/**
 * The small CLI commands on a real database, both dialects (PLAN T3.1): `migrate` on an empty database, then
 * "up to date"; `info` (text and JSON) with the counts and the restore flag; `check-config`; `jobs run`; `secret rotate`
 * writes a new key file and refuses while `MELOGOLD_SECRET_KEY` is set.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { parseEnv } from "../config/env.ts";
import type { Env } from "../config/env.ts";
import { secretKeyPath } from "../config/secret-key.ts";
import { captureOutput } from "../test/cli-output.ts";
import { createDevice, createUser } from "../test/factories.ts";
import { TEST_DIALECT, createTestDatabase } from "../test/test-db.ts";
import type { TestDatabase } from "../test/test-db.ts";
import { EXIT_FAILURE, EXIT_USAGE, runCli } from "./index.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

let database: TestDatabase;
let env: Env;

before(async () => {
  database = await createTestDatabase();
  env = parseEnv({ ...database.envVars, PUBLIC_URL: "https://music.example.com", INSTANCE_NAME: "Дом" });
});

after(async () => {
  await database.cleanup();
});

async function cli(args: readonly string[], envOverride: Env = env) {
  const captured = captureOutput();
  const code = await runCli(args, captured.output, { env: envOverride });
  return { code, stdout: captured.stdout(), stderr: captured.stderr() };
}

describe(`CLI basics (${TEST_DIALECT})`, () => {
  test("migrate applies every migration once", async () => {
    const first = await cli(["migrate"]);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /^applied: 0001_core/);
    const second = await cli(["migrate"]);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /^database is up to date \(\d+ migrations\)/);
  });

  test("info counts accounts and devices and shows the restore flag", async () => {
    const db = database.openDb();
    try {
      const user = await createUser(db, { now: Date.now() });
      await createDevice(db, user.id, { now: Date.now(), linkedVia: "register" });
      await createUser(db, { now: Date.now(), deletedAt: Date.now() });
    } finally {
      await db.destroy();
    }
    const json = await cli(["info", "--json"]);
    assert.equal(json.code, 0, json.stderr);
    const status = JSON.parse(json.stdout) as Record<string, unknown>;
    assert.equal(status.software, "melogold-server");
    assert.equal(status.instanceName, "Дом");
    assert.equal(status.publicUrl, "https://music.example.com");
    assert.deepEqual(status.users, { active: 1, deleted: 1 });
    assert.equal(status.devices, 1);
    assert.equal(status.restorePending, false);
    assert.match(String(status.serverId), /^[0-9a-f-]{36}$/);
    assert.deepEqual((status.db as Record<string, unknown>).dialect, TEST_DIALECT);

    const text = await cli(["info"]);
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /accounts: +1 active, 1 deleted/);
    assert.match(text.stdout, /restore: +none pending/);
  });

  test("check-config passes on a good setup and fails without a writable data directory", async () => {
    const good = await cli(["check-config"]);
    assert.equal(good.code, 0, good.stdout + good.stderr);
    assert.match(good.stdout, /^ok {4}environment$/m);
    assert.match(good.stdout, /^ok {4}database /m);

    const bad = await cli(["check-config"], parseEnv({ ...database.envVars, DATA_DIR: "/proc/melogold-nowhere" }));
    assert.equal(bad.code, EXIT_FAILURE);
    assert.match(bad.stdout, /^FAIL {2}data directory/m);
    assert.match(bad.stdout, /^warn {2}PUBLIC_URL is not set/m);
  });

  test("jobs run runs one job; an unknown job is a usage error", async () => {
    const ran = await cli(["jobs", "run", "auth-cleanup"]);
    assert.equal(ran.code, 0, ran.stderr);
    assert.equal(ran.stdout, "auth-cleanup: done\n");
    const unknown = await cli(["jobs", "run", "nope"]);
    assert.equal(unknown.code, EXIT_USAGE);
    assert.match(unknown.stderr, /unknown job "nope"; jobs: retention, auth-cleanup/);
  });

  test("secret rotate writes a new key file, and refuses when MELOGOLD_SECRET_KEY is set", async () => {
    await cli(["jobs", "run", "disk-guard"]); // creates the key file like a server start
    const before = readFileSync(secretKeyPath(env.DATA_DIR), "utf8");
    const rotated = await cli(["secret", "rotate"]);
    assert.equal(rotated.code, 0, rotated.stderr);
    assert.match(rotated.stdout, /every device will have to sign in again/);
    assert.notEqual(readFileSync(secretKeyPath(env.DATA_DIR), "utf8"), before);

    const withEnv = await cli(
      ["secret", "rotate"],
      parseEnv({ ...database.envVars, MELOGOLD_SECRET_KEY: "ab".repeat(32) }),
    );
    assert.equal(withEnv.code, EXIT_FAILURE);
    assert.match(withEnv.stderr, /MELOGOLD_SECRET_KEY is set/);
  });

  test("openapi prints the contract", async () => {
    const json = await cli(["openapi"]);
    assert.equal(json.code, 0);
    assert.equal((JSON.parse(json.stdout) as { openapi: string }).openapi, "3.0.3");
    const yaml = await cli(["openapi", "--yaml"]);
    assert.match(yaml.stdout, /^openapi: 3\.0\.3/m);
  });
  test("the image path (main.ts) runs info as its own process without loading fastify", () => {
    const script = `
      import { registerHooks } from "node:module";
      const seen = [];
      registerHooks({ resolve(specifier, context, next) { seen.push(specifier); return next(specifier, context); } });
      const { main } = await import("./src/main.ts");
      await main(["info", "--json"]);
      process.stderr.write(JSON.stringify(seen.filter((s) => s.includes("fastify"))));
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...database.envVars },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal((JSON.parse(result.stdout) as { software: string }).software, "melogold-server");
    assert.equal(result.stderr, "[]");
  });
});
