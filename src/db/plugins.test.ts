import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from "kysely";
import { StripRowLocksPlugin } from "./plugins.ts";

type Schema = { sync_heads: { user_id: string; seq: number }; users: { id: string } };

function compiler(dialect: "sqlite" | "postgres", strip: boolean): Kysely<Schema> {
  return new Kysely<Schema>({
    dialect: {
      createAdapter: () => (dialect === "sqlite" ? new SqliteAdapter() : new PostgresAdapter()),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => (dialect === "sqlite" ? new SqliteIntrospector(db) : new PostgresIntrospector(db)),
      createQueryCompiler: () => (dialect === "sqlite" ? new SqliteQueryCompiler() : new PostgresQueryCompiler()),
    },
    plugins: strip ? [new StripRowLocksPlugin()] : [],
  });
}

describe("StripRowLocksPlugin", () => {
  test("removes FOR UPDATE / FOR SHARE / NOWAIT / SKIP LOCKED, including in subqueries", () => {
    const db = compiler("sqlite", true);
    const query = db
      .selectFrom("sync_heads")
      .selectAll()
      .where("user_id", "=", "u1")
      .where("user_id", "in", (eb) => eb.selectFrom("users").select("id").forShare().skipLocked())
      .forUpdate()
      .noWait()
      .compile();
    assert.doesNotMatch(query.sql, /for (update|share)|nowait|skip locked/i);
    assert.match(
      query.sql,
      /^select \* from "sync_heads" where "user_id" = \? and "user_id" in \(select "id" from "users"\)$/,
    );
    assert.deepEqual(query.parameters, ["u1"]);
  });

  test("keeps DISTINCT and leaves PostgreSQL untouched when not installed", () => {
    const sqlite = compiler("sqlite", true).selectFrom("users").select("id").distinct().compile();
    assert.match(sqlite.sql, /^select distinct "id" from "users"$/);
    const postgres = compiler("postgres", false).selectFrom("sync_heads").selectAll().forUpdate().compile();
    assert.match(postgres.sql, /for update$/);
  });
});
