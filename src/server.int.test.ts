/**
 * The server process on both dialects (PLAN M0 acceptance):
 * - `startServer` applies a pending restore **before** it listens (every epoch rotated, flag cleared), serves
 *   `/health` over real HTTP and shuts down by draining;
 * - a database whose schema differs from the snapshot stops the start (`SchemaMismatchError`), and
 *   `node src/main.ts serve` exits with code 1;
 * - `node src/main.ts serve` answers `/health` and exits 0 on SIGTERM (close-with-grace).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseEnv } from "./config/env.ts";
import type { Db } from "./db/index.ts";
import { SchemaMismatchError } from "./db/schema-check.ts";
import { upsertMeta, readMeta } from "./modules/server/server.repository.ts";
import { initServerIdentity } from "./modules/server/server.service.ts";
import { startServer } from "./server.ts";
import { createUser } from "./test/factories.ts";
import { createMigratedTestDatabase } from "./test/test-db.ts";
import type { TestDatabase } from "./test/test-db.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

type Child = { code: number | null; stdout: string; stderr: string };

/** Runs `node src/main.ts serve` until it exits or `until(stdout)` holds; returns a handle to stop it. */
function serveProcess(envVars: Record<string, string>) {
  const child = spawn(process.execPath, ["src/main.ts", "serve"], { cwd: ROOT, env: envVars });
  const state: Child = { code: null, stdout: "", stderr: "" };
  child.stdout.on("data", (chunk: Buffer) => (state.stdout += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (state.stderr += chunk.toString("utf8")));
  const exited = new Promise<Child>((resolve) => {
    child.on("exit", (code) => {
      state.code = code;
      resolve(state);
    });
  });
  const waitFor = async (predicate: (text: string) => boolean, timeoutMs = 20_000): Promise<void> => {
    const started = Date.now();
    while (!predicate(state.stdout)) {
      if (state.code !== null) throw new Error(`server exited with ${state.code}: ${state.stderr}${state.stdout}`);
      if (Date.now() - started > timeoutMs) throw new Error(`timeout; output: ${state.stderr}${state.stdout}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  return { child, state, exited, waitFor };
}

let database: TestDatabase;
let db: Db;

before(async () => {
  ({ database, db } = await createMigratedTestDatabase());
});

after(async () => {
  await db.destroy();
  await database.cleanup();
});

describe("startServer", () => {
  test("rotates epochs before listening, serves /health, drains on shutdown", async () => {
    await initServerIdentity(db, Date.now());
    const users = [await createUser(db), await createUser(db)];
    await db.write((q) => upsertMeta(q, "restore_pending", "1"));

    const port = await freePort();
    const env = parseEnv({ ...database.envVars, HOST: "127.0.0.1", PORT: String(port), LOG_LEVEL: "silent" });
    const running = await startServer({ env, mountinfo: () => null });
    try {
      const heads = await db.read((q) => q.selectFrom("sync_heads").select(["user_id", "epoch"]).execute());
      for (const user of users) {
        assert.notEqual(heads.find((head) => head.user_id === user.id)?.epoch, user.epoch, "epoch rotated");
      }
      assert.equal(await db.read((q) => readMeta(q, "restore_pending")), null);
      assert.notEqual(await db.read((q) => readMeta(q, "restore_refresh_grace_until")), null);

      const response = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: "ok", version: "0.0.0-dev", db: database.dialect });
      assert.deepEqual(running.scheduler.names(), [
        "retention",
        "auth-cleanup",
        "account-purge",
        ...(database.dialect === "sqlite" ? ["sqlite-maintenance"] : []),
        "disk-guard",
      ]);
    } finally {
      await running.shutdown();
      await running.shutdown();
    }
    assert.ok(running.ctx.lifecycle.isDraining());
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
  });

  test("a schema that differs from the snapshot stops the start (exit code 1)", async () => {
    const { database: changed, db: changedDb } = await createMigratedTestDatabase();
    try {
      await changedDb.write((q) => q.schema.alterTable("devices").addColumn("extra", "text").execute());
      const env = parseEnv({
        ...changed.envVars,
        HOST: "127.0.0.1",
        PORT: String(await freePort()),
        LOG_LEVEL: "silent",
      });
      await assert.rejects(startServer({ env, mountinfo: () => null }), (error: unknown) => {
        assert.ok(error instanceof SchemaMismatchError);
        assert.equal(error.exitCode, 1);
        return true;
      });

      const failed = serveProcess({ ...changed.envVars, HOST: "127.0.0.1", PORT: String(await freePort()) });
      const result = await failed.exited;
      assert.equal(result.code, 1, result.stderr);
      assert.match(result.stderr, /startup failed/);
    } finally {
      await changedDb.destroy();
      await changed.cleanup();
    }
  });

  test("melogold serve: /health answers, SIGTERM drains and exits 0", async () => {
    const port = await freePort();
    const server = serveProcess({ ...database.envVars, HOST: "127.0.0.1", PORT: String(port), LOG_LEVEL: "info" });
    try {
      await server.waitFor((text) => text.includes("melogold server is listening"));
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(response.status, 200);
      server.child.kill("SIGTERM");
      const result = await server.exited;
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /shutting down/);
    } finally {
      if (server.state.code === null) server.child.kill("SIGKILL");
    }
  });
});
