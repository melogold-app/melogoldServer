/**
 * B1 (DESIGN §3.15, PLAN T3.1 `restore-epoch.int`): after a restore every old cursor is `410 cursor_invalid`, even once
 * the head has passed it again, and a refresh token rotated after the backup still works inside the grace window.
 *
 * SQLite runs the real commands against a real server: `backup` while it serves → more writes → stop → `restore` →
 * start → writes until the head passes the old cursor → the old cursor is 410. PostgreSQL is dumped and restored by
 * the host CLI (covered by the installer e2e, PLAN T3.3), so there the same property is checked through
 * `sync rotate-epoch --all` and a restart (DESIGN §3.15 item 4). Also here: `verify-backup`, `backup --out -`,
 * `restore --from -`, and the refusals of `restore`.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, before, describe, test } from "node:test";
import { parseEnv } from "../config/env.ts";
import type { Env } from "../config/env.ts";
import { startServer } from "../server.ts";
import type { RunningServer } from "../server.ts";
import { captureOutput } from "../test/cli-output.ts";
import { TEST_DIALECT, createMigratedTestDatabase } from "../test/test-db.ts";
import type { TestDatabase } from "../test/test-db.ts";
import { EXIT_FAILURE, runCli } from "./index.ts";
import type { Prompter } from "./password.ts";

const FAST_ARGON2 = { ARGON2_MEMORY_KIB: "19456", ARGON2_TIME_COST: "2" };
const HWID = randomBytes(32).toString("hex");

let database: TestDatabase;
let env: Env;
let work: string;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

before(async () => {
  const migrated = await createMigratedTestDatabase();
  await migrated.db.destroy();
  database = migrated.database;
  const port = await freePort();
  env = parseEnv({
    ...database.envVars,
    ...FAST_ARGON2,
    HOST: "127.0.0.1",
    PORT: String(port),
    LOG_LEVEL: "silent",
    RATE_LIMIT_ENABLED: "false",
    DISK_MIN_FREE_PERCENT: "1",
  });
  work = mkdtempSync(join(tmpdir(), "melogold-restore-"));
});

after(async () => {
  rmSync(work, { recursive: true, force: true });
  await database.cleanup();
});

const noPrompt: Prompter = {
  hidden: () => Promise.reject(new Error("no prompt expected")),
  visible: () => Promise.reject(new Error("no prompt expected")),
};

async function cli(args: readonly string[], stdin?: NodeJS.ReadableStream) {
  const captured = captureOutput();
  const code = await runCli(args, captured.output, { env, prompter: noPrompt, ...(stdin ? { stdin } : {}) });
  return { code, stdout: captured.stdout(), stderr: captured.stderr(), bytes: captured.bytes() };
}

function base(): string {
  return `http://127.0.0.1:${env.PORT}`;
}

async function call(
  path: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base()}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(path === "/sync" ? { "x-sync-protocol": "1" } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

type Session = { access: string; refresh: string };

function tokens(body: Record<string, unknown>): Session {
  const issued = body.tokens as { accessToken: string; refreshToken: string };
  return { access: issued.accessToken, refresh: issued.refreshToken };
}

let likeCount = 0;

/** Likes one more track; returns the cursor after it. */
async function like(session: Session, cursor: string): Promise<string> {
  likeCount += 1;
  const response = await call(
    "/sync",
    {
      cursor,
      ops: [
        {
          opId: randomUUID(),
          kind: "like.set",
          at: new Date().toISOString(),
          videoId: `v${String(likeCount).padStart(10, "0")}`,
          liked: true,
        },
      ],
    },
    session.access,
  );
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return String(response.body.cursor);
}

/** The sequence part of a cursor (`epoch.library.history`). */
function librarySeq(cursor: string): number {
  return Number(cursor.split(".")[1]);
}

async function withServer<T>(body: (server: RunningServer) => Promise<T>): Promise<T> {
  const running = await startServer({ env, mountinfo: () => null });
  try {
    return await body(running);
  } finally {
    await running.shutdown();
  }
}

describe(`restore and epochs (${TEST_DIALECT})`, () => {
  test("an old cursor is 410 after a restore even once the head passed it; a refresh from after the backup works", async () => {
    const backupFile = join(work, "melogold.sqlite");
    const state = await withServer(async () => {
      const registered = await call("/auth/register", {
        login: "restorer",
        password: "две собаки и кот",
        device: { hwid: HWID, name: "Pixel", platform: "android" },
      });
      assert.equal(registered.status, 201, JSON.stringify(registered.body));
      let session = tokens(registered.body);
      let cursor = await like(session, "");

      if (TEST_DIALECT === "sqlite") {
        const backup = await cli(["backup", "--out", backupFile]);
        assert.equal(backup.code, 0, backup.stderr);
      }

      for (let i = 0; i < 3; i++) cursor = await like(session, cursor);
      const refreshed = await call("/auth/refresh", { refreshToken: session.refresh, device: { hwid: HWID } });
      assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
      session = tokens(refreshed.body);
      return { session, cursor };
    });

    if (TEST_DIALECT === "sqlite") {
      const verify = await cli(["verify-backup", "--from", backupFile]);
      assert.equal(verify.code, 0, verify.stdout + verify.stderr);
      assert.match(verify.stdout, /^integrity: +ok$/m);
      assert.match(verify.stdout, /^restore flag: set$/m);
      assert.match(verify.stdout, /1 accounts, 1 devices, 1 likes/);

      const restore = await cli(["restore", "--from", backupFile, "--yes"]);
      assert.equal(restore.code, 0, restore.stderr);
      assert.match(restore.stdout, /1 accounts got a new sync epoch/);
      assert.match(restore.stdout, /the previous database is kept in /);
    } else {
      const rotate = await cli(["sync", "rotate-epoch", "--all"]);
      assert.equal(rotate.code, 0, rotate.stderr);
    }

    await withServer(async () => {
      // The refresh token rotated after the backup is unknown to the restored database but HMAC-valid: accepted.
      const refreshed = await call("/auth/refresh", { refreshToken: state.session.refresh, device: { hwid: HWID } });
      assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
      const session = tokens(refreshed.body);

      // Writes until the new head passes the old cursor's position.
      let fresh = await like(session, "");
      while (librarySeq(fresh) <= librarySeq(state.cursor)) fresh = await like(session, fresh);

      const stale = await call("/sync", { cursor: state.cursor }, session.access);
      assert.equal(stale.status, 410, JSON.stringify(stale.body));
      assert.equal(stale.body.code, "cursor_invalid");
      const current = await call("/sync", { cursor: fresh }, session.access);
      assert.equal(current.status, 200, JSON.stringify(current.body));
    });
  });

  test(
    "backup --out - streams the copy; restore --from - reads it back",
    { skip: TEST_DIALECT !== "sqlite" },
    async () => {
      const streamed = await cli(["backup", "--out", "-"]);
      assert.equal(streamed.code, 0, streamed.stderr);
      assert.equal(streamed.bytes.subarray(0, 16).toString("latin1"), "SQLite format 3\u0000");
      assert.match(streamed.stderr, /backup written to stdout \(\d+ bytes\)/);

      const restored = await cli(["restore", "--from", "-", "--yes"], Readable.from([streamed.bytes]));
      assert.equal(restored.code, 0, restored.stderr);
      assert.match(restored.stdout, /accounts got a new sync epoch/);
    },
  );

  test(
    "restore refuses a file that is not a Melogold database, or one from a newer server",
    { skip: TEST_DIALECT !== "sqlite" },
    async () => {
      const junk = join(work, "junk.sqlite");
      writeFileSync(junk, "not a database at all");
      const notDb = await cli(["restore", "--from", junk, "--yes"]);
      assert.equal(notDb.code, EXIT_FAILURE);

      const copy = join(work, "newer.sqlite");
      assert.equal((await cli(["backup", "--out", copy])).code, 0);
      const { openSqliteFile } = await import("../modules/maintenance/backup.ts");
      const newer = openSqliteFile(env, copy);
      try {
        await newer.kysely
          .insertInto("kysely_migration" as never)
          .values({ name: "9999_future", timestamp: new Date().toISOString() })
          .execute();
      } finally {
        await newer.destroy();
      }
      const verify = await cli(["verify-backup", "--from", copy]);
      assert.equal(verify.code, EXIT_FAILURE);
      assert.match(verify.stdout, /NEWER than this image: 9999_future/);
      const refused = await cli(["restore", "--from", copy, "--yes"]);
      assert.equal(refused.code, EXIT_FAILURE);
      assert.match(refused.stderr, /newer server \(unknown migrations: 9999_future\)/);
      assert.ok(readFileSync(copy).length > 0, "the refused copy is left alone");
    },
  );

  test("the image refuses backup and restore of PostgreSQL", { skip: TEST_DIALECT !== "postgres" }, async () => {
    const backup = await cli(["backup", "--out", join(work, "pg.sqlite")]);
    assert.equal(backup.code, EXIT_FAILURE);
    assert.match(backup.stderr, /done by the host command/);
  });
  test("sync rotate-epoch <login> gives one account a new epoch now; --all and a login exclude each other", async () => {
    const db = database.openDb();
    try {
      const epochOf = async () =>
        (
          await db.run((q) =>
            q
              .selectFrom("sync_heads")
              .innerJoin("users", "users.id", "sync_heads.user_id")
              .select("sync_heads.epoch")
              .where("users.login", "=", "restorer")
              .executeTakeFirstOrThrow(),
          )
        ).epoch;
      const before = await epochOf();
      const rotated = await cli(["sync", "rotate-epoch", "Restorer"]);
      assert.equal(rotated.code, 0, rotated.stderr);
      assert.match(rotated.stdout, /^restorer got a new sync epoch/);
      assert.notEqual(await epochOf(), before);
    } finally {
      await db.destroy();
    }
    assert.equal((await cli(["sync", "rotate-epoch"])).code, 64);
    assert.equal((await cli(["sync", "rotate-epoch", "--all", "restorer"])).code, 64);
    const ghost = await cli(["sync", "rotate-epoch", "ghost"]);
    assert.equal(ghost.code, EXIT_FAILURE);
    assert.match(ghost.stderr, /no active account "ghost"/);
  });
});
