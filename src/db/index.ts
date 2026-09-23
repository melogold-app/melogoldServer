/**
 * Database layer entry point (DESIGN §6.2, docs/database.md): opens the dialect chosen by `DATABASE_URL`.
 */
import { Kysely } from "kysely";
import type { KyselyPlugin } from "kysely";
import type { Env } from "../config/env.ts";
import type { SqlDialect } from "./ddl.ts";
import { createPostgresDialect, createPostgresPool } from "./dialect-postgres.ts";
import { createSqliteDialect, openSqlite } from "./dialect-sqlite.ts";
import { StatementCounterPlugin, StripRowLocksPlugin } from "./plugins.ts";

export type { SqlDialect } from "./ddl.ts";

/** The part of the environment the database layer reads (API §10). */
export type DbEnv = Pick<
  Env,
  | "DATABASE_URL"
  | "SQLITE_BUSY_TIMEOUT_MS"
  | "SQLITE_SYNCHRONOUS"
  | "DATABASE_POOL_MAX"
  | "DATABASE_SSL"
  | "DATABASE_SSL_CA_FILE"
  | "DATABASE_STATEMENT_TIMEOUT_MS"
>;

/** Structured logger (pino's `logger.warn(obj, msg)` shape). */
export type DbLogger = {
  info(details: object, message: string): void;
  warn(details: object, message: string): void;
  error(details: object, message: string): void;
};

const ignore = (): undefined => undefined;
export const silentDbLogger: DbLogger = Object.freeze({ info: ignore, warn: ignore, error: ignore });

export type OpenKyselyOptions = Readonly<{
  log?: DbLogger;
  /** PostgreSQL only: `search_path` of every connection (tests use one schema per test file). */
  searchPath?: string;
}>;

export type OpenedKysely<DB> = Readonly<{ dialect: SqlDialect; kysely: Kysely<DB> }>;

/**
 * Opens a Kysely instance for `DATABASE_URL` with the dialect specifics of API §9.4 and the layer's plugins. Most
 * code uses `createDb` instead; this is for tools that work below `db.read`/`db.write` (migrations, tests).
 */
export function openKysely<DB>(env: DbEnv, options: OpenKyselyOptions = {}): OpenedKysely<DB> {
  const log = options.log ?? silentDbLogger;
  const counter: KyselyPlugin = new StatementCounterPlugin();
  const url = env.DATABASE_URL;
  if (url.dialect === "sqlite") {
    const database = openSqlite({
      path: url.path,
      busyTimeoutMs: env.SQLITE_BUSY_TIMEOUT_MS,
      synchronous: env.SQLITE_SYNCHRONOUS,
    });
    const kysely = new Kysely<DB>({
      dialect: createSqliteDialect(database),
      plugins: [new StripRowLocksPlugin(), counter],
    });
    return Object.freeze({ dialect: "sqlite", kysely });
  }
  const pool = createPostgresPool({
    url: url.url,
    poolMax: env.DATABASE_POOL_MAX,
    statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
    ssl: env.DATABASE_SSL,
    sslCaFile: env.DATABASE_SSL_CA_FILE,
    ...(options.searchPath === undefined ? {} : { searchPath: options.searchPath }),
    onPoolError: (error) => {
      log.error({ err: error }, "idle PostgreSQL connection failed");
    },
  });
  const kysely = new Kysely<DB>({ dialect: createPostgresDialect(pool), plugins: [counter] });
  return Object.freeze({ dialect: "postgres", kysely });
}
