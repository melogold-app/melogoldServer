import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { sql } from "kysely";
import type { Generated, Kysely } from "kysely";
import { TEST_DIALECT, createTestDatabase } from "../test/test-db.ts";
import type { TestDatabase } from "../test/test-db.ts";
import { CodecError } from "./codecs.ts";
import { ddl } from "./ddl.ts";
import { createTxRunner } from "./tx.ts";
import type { TxRunner } from "./tx.ts";

type Schema = {
  typed: { id: string; label: string | null; small: Generated<number>; big: Generated<number>; flag: Generated<0 | 1> };
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
    d.createTable("typed", {
      id: d.types.ID.notNull().primaryKey(),
      label: d.types.TXT.nullable(),
      small: d.types.INT.notNull().default(0),
      big: d.types.BIG.notNull().default(0),
      flag: d.types.BOOL.notNull().default(0),
    }),
  );
});

after(async () => {
  await kysely.destroy();
  await database.cleanup();
});

describe(`dialect specifics (${TEST_DIALECT})`, () => {
  test('ID columns compare byte-wise in both dialects (COLLATE "C" on PostgreSQL)', async () => {
    await tx.write((q) =>
      q
        .insertInto("typed")
        .values([{ id: "a" }, { id: "B" }, { id: "_" }, { id: "b" }, { id: "A" }])
        .execute(),
    );
    const rows = await tx.read((q) => q.selectFrom("typed").select("id").orderBy("id").execute());
    assert.deepEqual(
      rows.map((row) => row.id),
      ["A", "B", "_", "a", "b"],
    );
    const range = await tx.read((q) =>
      q.selectFrom("typed").select("id").where("id", ">", "Z").orderBy("id").execute(),
    );
    assert.deepEqual(
      range.map((row) => row.id),
      ["_", "a", "b"],
    );
    await tx.write((q) => q.deleteFrom("typed").execute());
  });

  test("BOOL columns accept only 0 and 1", async () => {
    await assert.rejects(tx.write((q) => sql`INSERT INTO typed (id, flag) VALUES ('x', 2)`.execute(q)));
    await tx.write((q) => q.insertInto("typed").values({ id: "y", flag: 1 }).execute());
    const row = await tx.read((q) => q.selectFrom("typed").select("flag").where("id", "=", "y").executeTakeFirst());
    assert.equal(row?.flag, 1);
    await tx.write((q) => q.deleteFrom("typed").execute());
  });

  test("integers come back as numbers, including count(*) and sum() over bigint", async () => {
    await tx.write((q) =>
      q
        .insertInto("typed")
        .values([
          { id: "n1", small: 2_147_483_647, big: Number.MAX_SAFE_INTEGER - 10 },
          { id: "n2", small: 1, big: 5 },
        ])
        .execute(),
    );
    const totals = await tx.read((q) =>
      q
        .selectFrom("typed")
        .select((eb) => [eb.fn.countAll().as("rows"), eb.fn.sum("big").as("total"), eb.fn.max("small").as("top")])
        .executeTakeFirstOrThrow(),
    );
    assert.deepEqual(totals, { rows: 2, total: Number.MAX_SAFE_INTEGER - 5, top: 2_147_483_647 });
    const big = await tx.read((q) => q.selectFrom("typed").select("big").where("id", "=", "n1").executeTakeFirst());
    assert.equal(big?.big, Number.MAX_SAFE_INTEGER - 10);
    await tx.write((q) => q.deleteFrom("typed").execute());
  });

  test("DDL is transactional: a rolled back CREATE TABLE leaves nothing behind", async () => {
    await assert.rejects(
      tx.write(async (q) => {
        await sql`CREATE TABLE rolled_back (id text NOT NULL PRIMARY KEY)`.execute(q);
        throw new Error("rollback");
      }),
      /rollback/,
    );
    await assert.rejects(tx.read((q) => sql`SELECT count(*) FROM rolled_back`.execute(q)));
  });
});

describe("SQLite connection", { skip: TEST_DIALECT !== "sqlite" }, () => {
  async function pragma(name: string): Promise<unknown> {
    const result = await tx.run((q) => sql<Record<string, unknown>>`PRAGMA ${sql.raw(name)}`.execute(q));
    const row = result.rows[0];
    return row === undefined ? undefined : Object.values(row)[0];
  }

  test("PRAGMAs of API §9.4 and auto_vacuum for a new database (API §9.1 rule 8)", async () => {
    assert.equal(await pragma("journal_mode"), "wal");
    assert.equal(await pragma("synchronous"), 2); // FULL
    assert.equal(await pragma("foreign_keys"), 1);
    assert.equal(await pragma("busy_timeout"), 5000);
    assert.equal(await pragma("temp_store"), 2); // MEMORY
    assert.equal(await pragma("cache_size"), -16000);
    assert.equal(await pragma("journal_size_limit"), 67_108_864);
    assert.equal(await pragma("auto_vacuum"), 2); // INCREMENTAL
    assert.equal(await pragma("query_only"), 0);
  });

  test("tables are STRICT: a text value in an INTEGER column is rejected", async () => {
    await assert.rejects(
      tx.write((q) => sql`INSERT INTO typed (id, small) VALUES ('s', 'not a number')`.execute(q)),
      (error: unknown) => (error as { code?: string }).code === "SQLITE_CONSTRAINT_DATATYPE",
    );
  });

  test("SQLITE_SYNCHRONOUS=NORMAL is applied", async () => {
    const other = await createTestDatabase({ env: { SQLITE_SYNCHRONOUS: "NORMAL" } });
    const opened = other.openKysely<Schema>();
    try {
      const result = await sql<{ synchronous: number }>`PRAGMA synchronous`.execute(opened.kysely);
      assert.equal(result.rows[0]?.synchronous, 1);
    } finally {
      await opened.kysely.destroy();
      await other.cleanup();
    }
  });
});

describe("PostgreSQL connection", { skip: TEST_DIALECT !== "postgres" }, () => {
  async function setting(name: string): Promise<string> {
    const result = await tx.run((q) => sql<{ value: string }>`SELECT current_setting(${name}) AS value`.execute(q));
    return result.rows[0]?.value ?? "";
  }

  test("pool settings: application_name, statement_timeout, search_path", async () => {
    assert.equal(await setting("application_name"), "melogold");
    assert.equal(await setting("statement_timeout"), "15s");
    assert.equal(await setting("search_path"), database.searchPath);
    const schema = await tx.run((q) => sql<{ schema: string }>`SELECT current_schema() AS schema`.execute(q));
    assert.equal(schema.rows[0]?.schema, database.searchPath);
  });

  test("the test database uses a non-C collation (en_US.UTF-8), so ID collation bugs surface", async () => {
    const result = await tx.run((q) =>
      sql<{
        collate: string;
      }>`SELECT datcollate AS collate FROM pg_database WHERE datname = current_database()`.execute(q),
    );
    assert.equal(result.rows[0]?.collate, "en_US.UTF-8");
  });

  test("bigint beyond 2^53 − 1 throws instead of losing precision", async () => {
    await assert.rejects(
      tx.run((q) => sql`SELECT 9007199254740993::bigint AS value`.execute(q)),
      CodecError,
    );
    const ok = await tx.run((q) => sql<{ value: number }>`SELECT 9007199254740991::bigint AS value`.execute(q));
    assert.equal(ok.rows[0]?.value, Number.MAX_SAFE_INTEGER);
  });

  test("db.read runs REPEATABLE READ READ ONLY, db.write READ COMMITTED", async () => {
    const read = await tx.read((q) =>
      sql<{
        isolation: string;
        readOnly: string;
      }>`SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS "readOnly"`.execute(
        q,
      ),
    );
    assert.deepEqual(read.rows[0], { isolation: "repeatable read", readOnly: "on" });
    const write = await tx.write((q) =>
      sql<{
        isolation: string;
        readOnly: string;
      }>`SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS "readOnly"`.execute(
        q,
      ),
    );
    assert.deepEqual(write.rows[0], { isolation: "read committed", readOnly: "off" });
  });
});
