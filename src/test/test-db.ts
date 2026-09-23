/**
 * Test databases for `*.int.test.ts` (DESIGN §10). Every integration test runs on both dialects:
 * - `TEST_DB=sqlite` (`npm test`): a fresh file in a temporary directory, WAL like production;
 * - `TEST_DB=postgres` (`npm run test:pg`): a fresh schema in `TEST_DATABASE_URL` (PostgreSQL 18, locale
 *   `en_US.UTF-8` from `compose.dev.yml`), selected through `search_path`.
 *
 * This module (with `scripts/`) may read `process.env` besides `src/config/env.ts` (DESIGN §6.3).
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { parseEnv } from "../config/env.ts";
import type { Env } from "../config/env.ts";
import { dbFromKysely, openKysely, silentDbLogger } from "../db/index.ts";
import type { Database, Db, DbOptions, OpenedKysely, OpenKyselyOptions, SqlDialect } from "../db/index.ts";
import { migrateToLatest } from "../db/migrate.ts";

function readTestDialect(): SqlDialect {
  const value = process.env.TEST_DB ?? "sqlite";
  if (value !== "sqlite" && value !== "postgres") throw new Error(`TEST_DB must be sqlite or postgres, got "${value}"`);
  return value;
}

export const TEST_DIALECT: SqlDialect = readTestDialect();

export const DEFAULT_TEST_DATABASE_URL = "postgres://melogold:melogold@127.0.0.1:55432/melogold";

export function testDatabaseUrl(): string {
  return process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
}

/** An empty database of {@link TEST_DIALECT}, owned by one test file. */
export type TestDatabase = Readonly<{
  dialect: SqlDialect;
  /** Parsed environment pointing at this database (`NODE_ENV=test`). */
  env: Env;
  /** PostgreSQL: the schema of this database; SQLite: `undefined`. */
  searchPath: string | undefined;
  /** SQLite: the database file; PostgreSQL: the schema name. For messages. */
  location: string;
  /**
   * `DATABASE_URL` that reaches this database from `startServer` or a child process: the SQLite file, or the
   * PostgreSQL URL with `options=-c search_path=<schema>`.
   */
  url: string;
  /** Environment variables pointing at this database (`NODE_ENV=test`, `DATA_DIR`, `DATABASE_URL`). */
  envVars: Readonly<Record<string, string>>;
  /** Opens one more independent connection (pool) to the same database: "another process". */
  openKysely<DB>(options?: Omit<OpenKyselyOptions, "searchPath">): OpenedKysely<DB>;
  /** Opens `ctx.db` (`createDb`) on the same database, over its own connection (pool). */
  openDb(options?: DbOptions): Db;
  /** Drops the schema or deletes the directory. Close every Kysely instance first. */
  cleanup(): Promise<void>;
}>;

export type CreateTestDatabaseOptions = Readonly<{
  /** Extra environment variables (e.g. `SQLITE_BUSY_TIMEOUT_MS`). */
  env?: Readonly<Record<string, string>>;
}>;

export async function createTestDatabase(options: CreateTestDatabaseOptions = {}): Promise<TestDatabase> {
  if (TEST_DIALECT === "sqlite") {
    const directory = mkdtempSync(join(tmpdir(), "melogold-test-"));
    const file = join(directory, "melogold.db");
    const envVars = { NODE_ENV: "test", DATA_DIR: directory, DATABASE_URL: `sqlite://${file}`, ...options.env };
    const env = parseEnv(envVars);
    return Object.freeze({
      dialect: "sqlite",
      env,
      searchPath: undefined,
      location: file,
      url: `sqlite://${file}`,
      envVars: Object.freeze(envVars),
      openKysely: <DB>(openOptions: Omit<OpenKyselyOptions, "searchPath"> = {}) => openKysely<DB>(env, openOptions),
      openDb: (dbOptions: DbOptions = {}) => dbFromKysely(openKysely<Database>(env, dbOptions), dbOptions),
      cleanup: () => {
        rmSync(directory, { recursive: true, force: true });
        return Promise.resolve();
      },
    });
  }

  const url = testDatabaseUrl();
  const schema = `test_${process.pid}_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
  } finally {
    await admin.end();
  }
  const dataDir = mkdtempSync(join(tmpdir(), "melogold-test-"));
  const env = parseEnv({
    NODE_ENV: "test",
    DATA_DIR: dataDir,
    DATABASE_URL: url,
    DATABASE_POOL_MAX: "5",
    ...options.env,
  });
  const scopedUrl = new URL(url);
  scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
  const envVars = {
    NODE_ENV: "test",
    DATA_DIR: dataDir,
    DATABASE_URL: scopedUrl.toString(),
    DATABASE_POOL_MAX: "5",
    ...options.env,
  };
  return Object.freeze({
    dialect: "postgres",
    env,
    searchPath: schema,
    location: schema,
    url: scopedUrl.toString(),
    envVars: Object.freeze(envVars),
    openKysely: <DB>(openOptions: Omit<OpenKyselyOptions, "searchPath"> = {}) =>
      openKysely<DB>(env, { ...openOptions, searchPath: schema }),
    openDb: (dbOptions: DbOptions = {}) =>
      dbFromKysely(openKysely<Database>(env, { ...dbOptions, searchPath: schema }), dbOptions),
    cleanup: async () => {
      rmSync(dataDir, { recursive: true, force: true });
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      try {
        await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await client.end();
      }
    },
  });
}

/** A test database with every migration applied, and `ctx.db` opened on it. Close `db` before `cleanup()`. */
export type MigratedTestDatabase = Readonly<{ database: TestDatabase; db: Db }>;

export async function createMigratedTestDatabase(
  options: CreateTestDatabaseOptions & Readonly<{ db?: DbOptions }> = {},
): Promise<MigratedTestDatabase> {
  const database = await createTestDatabase(options);
  const db = database.openDb(options.db);
  try {
    await migrateToLatest(db, { log: silentDbLogger });
  } catch (error) {
    await db.destroy();
    await database.cleanup();
    throw error;
  }
  return Object.freeze({ database, db });
}
