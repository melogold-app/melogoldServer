/**
 * PostgreSQL dialect (`pg` pool), API §9.4:
 * - `pg.Pool({max: DATABASE_POOL_MAX, statement_timeout, ssl, application_name: "melogold"})`;
 * - `pg.types.setTypeParser(20, safeInt)`: `bigint` becomes a number, and a value outside ±(2^53 − 1) throws instead
 *   of losing precision. `numeric` (1700, what `sum(bigint)` returns) gets the same treatment, so aggregates come back
 *   as numbers in both dialects;
 * - `db.write` → `READ COMMITTED`, `db.read` → `REPEATABLE READ READ ONLY` (Kysely's `PostgresDriver` renders them);
 * - migrations: Kysely's advisory lock and one transaction.
 *
 * `DATABASE_SSL`: `disable` → no TLS; `require` → TLS without certificate checks (libpq `sslmode=require`);
 * `verify-full` → TLS with CA and host name verification, the CA from `DATABASE_SSL_CA_FILE` when set. An `sslmode`
 * inside `DATABASE_URL` takes precedence (that is how `pg` merges the two).
 */
import { readFileSync } from "node:fs";
import pg from "pg";
import { PostgresAdapter, PostgresDriver, PostgresIntrospector, PostgresQueryCompiler } from "kysely";
import type { Dialect } from "kysely";
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

export function createPostgresDialect(pool: pg.Pool): Dialect {
  return {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new PostgresDriver({ pool }),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  };
}
