import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import Database from "better-sqlite3";
import { sql } from "kysely";
import type { Kysely } from "kysely";
import { parseEnv } from "../config/env.ts";
import { TEST_DIALECT, createTestDatabase } from "../test/test-db.ts";
import type { TestDatabase } from "../test/test-db.ts";
import { ddl } from "./ddl.ts";
import { constraintViolation, translateDbError } from "./errors.ts";
import { openKysely } from "./index.ts";
import { createTxRunner } from "./tx.ts";
import type { TxRunner } from "./tx.ts";

type Schema = {
  parents: { id: string; code: string };
  children: { id: string; parent_id: string };
};

let database: TestDatabase;
let kysely: Kysely<Schema>;
let tx: TxRunner<Schema>;

before(async () => {
  database = await createTestDatabase();
  const opened = database.openKysely<Schema>();
  kysely = opened.kysely;
  tx = createTxRunner(kysely);
  const d = ddl(opened.dialect);
  await d.run(
    kysely,
    d.createTable("parents", { id: d.types.ID.notNull().primaryKey(), code: d.types.ID.notNull().unique() }),
    d.createTable("children", {
      id: d.types.ID.notNull().primaryKey(),
      parent_id: d.types.ID.notNull().references("parents", "id", "CASCADE"),
    }),
  );
  await tx.write((q) => q.insertInto("parents").values({ id: "p1", code: "c1" }).execute());
});

after(async () => {
  await kysely.destroy();
  await database.cleanup();
});

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected the database call to fail");
}

describe(`driver errors (${TEST_DIALECT})`, () => {
  test("unique violation: recognized for the service, not translated (500 unless the service maps it)", async () => {
    const error = await failure(tx.write((q) => q.insertInto("parents").values({ id: "p2", code: "c1" }).execute()));
    assert.equal(translateDbError(error), null);
    const violation = constraintViolation(error);
    assert.equal(violation?.kind, "unique");
    assert.equal(violation.table, "parents");
    assert.deepEqual(violation.columns, ["code"]);
  });

  test("primary key violation is a unique violation", async () => {
    const error = await failure(tx.write((q) => q.insertInto("parents").values({ id: "p1", code: "other" }).execute()));
    assert.equal(constraintViolation(error)?.kind, "unique");
    assert.deepEqual(constraintViolation(error)?.columns, ["id"]);
  });

  test("foreign key violation", async () => {
    const error = await failure(
      tx.write((q) => q.insertInto("children").values({ id: "k1", parent_id: "missing" }).execute()),
    );
    assert.equal(translateDbError(error), null);
    assert.equal(constraintViolation(error)?.kind, "foreign_key");
  });

  test("no connection to PostgreSQL → 503 unavailable, Retry-After 5", async () => {
    const env = parseEnv({ NODE_ENV: "test", DATABASE_URL: "postgres://nobody:secret@127.0.0.1:1/none" });
    const unreachable = openKysely<Schema>(env);
    try {
      const error = await failure(sql`SELECT 1`.execute(unreachable.kysely));
      assert.deepEqual(translateDbError(error), { statusCode: 503, code: "unavailable", retryAfterSeconds: 5 });
    } finally {
      await unreachable.kysely.destroy();
    }
  });
});

describe("SQLite driver errors", { skip: TEST_DIALECT !== "sqlite" }, () => {
  test("SQLITE_BUSY after busy_timeout → 503 server_busy, Retry-After 1..2", async () => {
    const other = await createTestDatabase({ env: { SQLITE_BUSY_TIMEOUT_MS: "100" } });
    const opened = other.openKysely<Schema>();
    const runner = createTxRunner(opened.kysely);
    await runner.run((q) => sql`CREATE TABLE t (id INTEGER PRIMARY KEY)`.execute(q));
    // Another writer (think: the CLI in a second process) holds the write lock.
    const holder = new Database(other.location);
    holder.exec("BEGIN IMMEDIATE");
    try {
      const error = await failure(runner.write((q) => sql`INSERT INTO t (id) VALUES (1)`.execute(q)));
      assert.match(String((error as { code?: string }).code), /^SQLITE_BUSY/);
      assert.deepEqual(
        translateDbError(error, () => 0.9),
        {
          statusCode: 503,
          code: "server_busy",
          retryAfterSeconds: 2,
        },
      );
      assert.equal(translateDbError(error, () => 0.1)?.retryAfterSeconds, 1);
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
    await runner.write((q) => sql`INSERT INTO t (id) VALUES (1)`.execute(q));
    await opened.kysely.destroy();
    await other.cleanup();
  });

  test("SQLITE_FULL → 503 storage_full, Retry-After 600", async () => {
    const other = await createTestDatabase();
    const opened = other.openKysely<Schema>();
    const runner = createTxRunner(opened.kysely);
    try {
      await runner.run((q) => sql`CREATE TABLE blobs (id INTEGER PRIMARY KEY, body TEXT NOT NULL)`.execute(q));
      const pages = await runner.run((q) => sql<{ page_count: number }>`PRAGMA page_count`.execute(q));
      const limit = (pages.rows[0]?.page_count ?? 0) + 4;
      await runner.run((q) => sql`PRAGMA max_page_count = ${sql.raw(String(limit))}`.execute(q));
      const error = await failure(
        runner.write(async (q) => {
          for (let id = 1; id <= 100; id++) {
            await sql`INSERT INTO blobs (id, body) VALUES (${id}, ${"x".repeat(4000)})`.execute(q);
          }
        }),
      );
      assert.equal((error as { code?: string }).code, "SQLITE_FULL");
      assert.deepEqual(translateDbError(error), { statusCode: 503, code: "storage_full", retryAfterSeconds: 600 });
    } finally {
      await opened.kysely.destroy();
      await other.cleanup();
    }
  });
});

describe("PostgreSQL driver errors", { skip: TEST_DIALECT !== "postgres" }, () => {
  test("statement_timeout (57014) → 503 server_busy", async () => {
    const error = await failure(
      tx.write(async (q) => {
        await sql`SET LOCAL statement_timeout = 50`.execute(q);
        await sql`SELECT pg_sleep(2)`.execute(q);
      }),
    );
    assert.equal((error as { code?: string }).code, "57014");
    assert.equal(translateDbError(error)?.code, "server_busy");
  });

  test("lock_timeout (55P03) → 503 server_busy", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const other = database.openKysely<Schema>();
    const otherTx = createTxRunner(other.kysely);
    const holder = otherTx.write(async (q) => {
      await q.selectFrom("parents").select("id").where("id", "=", "p1").forUpdate().execute();
      locked();
      await held;
    });
    try {
      await isLocked;
      const error = await failure(
        tx.write(async (q) => {
          await sql`SET LOCAL lock_timeout = 50`.execute(q);
          await q.selectFrom("parents").select("id").where("id", "=", "p1").forUpdate().execute();
        }),
      );
      assert.equal((error as { code?: string }).code, "55P03");
      assert.equal(translateDbError(error)?.code, "server_busy");
    } finally {
      release();
      await holder;
      await other.kysely.destroy();
    }
  });

  test("NUL in text (22021) is not translated: it must never reach the database (API §1.4)", async () => {
    const error = await failure(
      tx.write((q) => q.insertInto("parents").values({ id: "nul", code: "a\u0000b" }).execute()),
    );
    assert.equal((error as { code?: string }).code, "22021");
    assert.equal(translateDbError(error), null);
  });

  test("integer overflow (22003) is not translated", async () => {
    const error = await failure(tx.run((q) => sql`SELECT 2147483647::integer + 1`.execute(q)));
    assert.equal((error as { code?: string }).code, "22003");
    assert.equal(translateDbError(error), null);
  });
});
