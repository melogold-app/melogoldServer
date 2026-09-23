/**
 * PostgreSQL dialect (`pg` pool), API §9.4:
 * - `pg.Pool({max: DATABASE_POOL_MAX, statement_timeout, ssl, application_name: "melogold"})`;
 * - `pg.types.setTypeParser(20, safeInt)`: `bigint` becomes a number, and a value outside ±(2^53 − 1) throws instead
 *   of losing precision. `numeric` (1700, what `sum(bigint)` returns) gets the same treatment, so aggregates come back
 *   as numbers in both dialects;
 * - `db.write` → `READ COMMITTED`, `db.read` → `REPEATABLE READ READ ONLY` (Kysely's `PostgresDriver` renders them);
 * - migrations: Kysely's advisory lock and one transaction;
 * - introspection sees only `current_schema()` ({@link CurrentSchemaIntrospector}).
 *
 * `DATABASE_SSL`: `disable` → no TLS; `require` → TLS without certificate checks (libpq `sslmode=require`);
 * `verify-full` → TLS with CA and host name verification, the CA from `DATABASE_SSL_CA_FILE` when set. An `sslmode`
 * inside `DATABASE_URL` takes precedence (that is how `pg` merges the two).
 */
import { readFileSync } from "node:fs";
import pg from "pg";
import { DEFAULT_MIGRATION_LOCK_TABLE, DEFAULT_MIGRATION_TABLE } from "kysely/migration";
import { PostgresAdapter, PostgresDriver, PostgresIntrospector, PostgresQueryCompiler, sql } from "kysely";
import type {
  DatabaseIntrospector,
  DatabaseMetadataOptions,
  Dialect,
  Kysely,
  SchemaMetadata,
  TableMetadata,
} from "kysely";
import { safeInt, safeIntegerNumeric } from "./codecs.ts";

export type PostgresSsl = "disable" | "require" | "verify-full";

export type PostgresOptions = Readonly<{
  url: string;
  poolMax: number;
  statementTimeoutMs: number;
  ssl: PostgresSsl;
  sslCaFile: string | null;
  /** Sets `search_path` for every connection (tests: one schema per test file). */
  searchPath?: string;
  /** Errors of idle pooled clients (the server restarted, the network dropped). */
  onPoolError?: (error: Error) => void;
}>;

/** How long a request waits for a free pooled client before `server_busy` (and for a new connection). */
export const POOL_CONNECTION_TIMEOUT_MS = 10_000;
export const APPLICATION_NAME = "melogold";

let typeParsersInstalled = false;

/** Installs the int8/numeric parsers on the global `pg.types` (idempotent). */
export function installPgTypeParsers(): void {
  if (typeParsersInstalled) return;
  pg.types.setTypeParser(pg.types.builtins.INT8, safeInt);
  pg.types.setTypeParser(pg.types.builtins.NUMERIC, safeIntegerNumeric);
  typeParsersInstalled = true;
}

function sslConfig(options: PostgresOptions): pg.PoolConfig["ssl"] {
  switch (options.ssl) {
    case "disable":
      return false;
    case "require":
      return { rejectUnauthorized: false };
    case "verify-full":
      return options.sslCaFile === null
        ? { rejectUnauthorized: true }
        : { rejectUnauthorized: true, ca: readFileSync(options.sslCaFile, "utf8") };
  }
}

const SEARCH_PATH = /^[a-z_][a-z0-9_]*$/;

export function createPostgresPool(options: PostgresOptions): pg.Pool {
  installPgTypeParsers();
  if (options.searchPath !== undefined && !SEARCH_PATH.test(options.searchPath)) {
    throw new Error(`invalid search_path "${options.searchPath}"`);
  }
  const pool = new pg.Pool({
    connectionString: options.url,
    max: options.poolMax,
    statement_timeout: options.statementTimeoutMs,
    ssl: sslConfig(options),
    application_name: APPLICATION_NAME,
    connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT_MS,
    ...(options.searchPath === undefined ? {} : { options: `-c search_path=${options.searchPath}` }),
  });
  // Without a listener an error on an idle client would crash the process.
  pool.on("error", (error) => options.onPoolError?.(error));
  return pool;
}

type ColumnRow = {
  column: string;
  notNull: boolean;
  hasDefault: boolean;
  table: string;
  tableType: string;
  schema: string;
  type: string;
  typeSchema: string;
  description: string | null;
  sequence: string | null;
};

/**
 * Kysely's `PostgresIntrospector` lists the tables of **every** schema of the database, resolving schema names on the
 * way (`has_schema_privilege`, `pg_get_serial_sequence`), so it fails with 3F000 when another schema is dropped at the
 * same moment (parallel test files, each in its own schema) and scans far more than Melogold owns. This one reads
 * only `current_schema()`: the schema Melogold's unqualified tables live in. The migrator uses it to find
 * `kysely_migration`.
 */
export class CurrentSchemaIntrospector implements DatabaseIntrospector {
  readonly #db: Kysely<unknown>;
  readonly #schemas: PostgresIntrospector;

  constructor(db: Kysely<unknown>) {
    this.#db = db;
    this.#schemas = new PostgresIntrospector(db);
  }

  getSchemas(): Promise<SchemaMetadata[]> {
    return this.#schemas.getSchemas();
  }

  async getTables(options: DatabaseMetadataOptions = { withInternalKyselyTables: false }): Promise<TableMetadata[]> {
    const { rows } = await sql<ColumnRow>`
      SELECT a.attname AS "column", a.attnotnull AS "notNull", a.atthasdef AS "hasDefault", c.relname AS "table",
             c.relkind AS "tableType", ns.nspname AS "schema", typ.typname AS "type", dtns.nspname AS "typeSchema",
             col_description(a.attrelid, a.attnum) AS "description",
             pg_get_serial_sequence(c.oid::regclass::text, a.attname) AS "sequence"
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON a.attrelid = c.oid
      JOIN pg_catalog.pg_namespace ns ON c.relnamespace = ns.oid
      JOIN pg_catalog.pg_type typ ON a.atttypid = typ.oid
      JOIN pg_catalog.pg_namespace dtns ON typ.typnamespace = dtns.oid
      WHERE ns.nspname = current_schema() AND c.relkind IN ('r', 'v', 'p', 'f')
        AND a.attnum >= 0 AND NOT a.attisdropped
      ORDER BY c.relname, a.attnum
    `.execute(this.#db);
    const internal = new Set([DEFAULT_MIGRATION_TABLE, DEFAULT_MIGRATION_LOCK_TABLE]);
    const tables = new Map<string, TableMetadata>();
    for (const row of rows) {
      if (!options.withInternalKyselyTables && internal.has(row.table)) continue;
      let table = tables.get(row.table);
      if (!table) {
        table = {
          name: row.table,
          schema: row.schema,
          isView: row.tableType === "v",
          isForeign: row.tableType === "f",
          columns: [],
        };
        tables.set(row.table, table);
      }
      table.columns.push({
        name: row.column,
        dataType: row.type,
        dataTypeSchema: row.typeSchema,
        isNullable: !row.notNull,
        hasDefaultValue: row.hasDefault,
        isAutoIncrementing: row.sequence !== null,
        ...(row.description === null ? {} : { comment: row.description }),
      });
    }
    return [...tables.values()];
  }

  async getMetadata(options?: DatabaseMetadataOptions): Promise<{ tables: TableMetadata[] }> {
    return { tables: await this.getTables(options) };
  }
}

export function createPostgresDialect(pool: pg.Pool): Dialect {
  return {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new PostgresDriver({ pool }),
    createIntrospector: (db) => new CurrentSchemaIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  };
}
