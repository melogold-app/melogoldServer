/**
 * Database layer entry point (DESIGN §6.2, docs/database.md): opens the dialect chosen by `DATABASE_URL` and exposes
 * `db.read`/`db.write`/`db.run` ({@link createDb}). Migrations and the schema check live in `migrate.ts` and
 * `schema-check.ts`.
 */
import { Kysely } from "kysely";
import type { KyselyPlugin } from "kysely";
import type { Env } from "../config/env.ts";
import type { SqlDialect } from "./ddl.ts";
import { createPostgresDialect, createPostgresPool } from "./dialect-postgres.ts";
import { createSqliteDialect, openSqlite } from "./dialect-sqlite.ts";
import { ensureHead } from "./heads.ts";
import { StatementCounterPlugin, StripRowLocksPlugin } from "./plugins.ts";
import { createTxRunner } from "./tx.ts";
import type { TxRunner } from "./tx.ts";
import type { Database } from "./types.ts";

export type { SqlDialect } from "./ddl.ts";
export type { Database } from "./types.ts";
export type { TxRunner } from "./tx.ts";

/**
 * What repositories and shared helpers receive as `q`: a transaction of `db.read`/`db.write` (or the handle of
 * `db.run`). Code outside `src/db/**` may not import `kysely` (ESLint), so it names the type through this alias.
 */
export type Queryable = Kysely<Database>;

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
 * code uses {@link createDb} instead; this is for tools that work below `db.read`/`db.write` (tests, tooling).
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

/**
 * The application's database handle (`ctx.db`): `read`, `write` and `run` of `tx.ts`, with the missing-head retry of
 * API §9.5 wired to `ensureHead`.
 */
export type Db = TxRunner<Database> &
  Readonly<{
    dialect: SqlDialect;
    /**
     * The Kysely instance below the transaction runner, for tooling only (migrations, the schema check, tests).
     * Services and repositories always go through `read`/`write`/`run`.
     */
    kysely: Kysely<Database>;
    /** Closes the pool or the SQLite file. */
    destroy(): Promise<void>;
  }>;

export type DbOptions = Readonly<{
  log?: DbLogger;
  /** Epoch milliseconds for `ensureHead` (the application's clock; default `Date.now`). */
  now?: () => number;
  /** Transactions longer than this are logged (default 2 s, DESIGN §6.2). */
  slowMs?: number;
}>;

/** Wraps an opened Kysely instance into {@link Db}; `createDb` and tests use it. */
export function dbFromKysely(opened: OpenedKysely<Database>, options: DbOptions = {}): Db {
  const now = options.now ?? Date.now;
  const runner: TxRunner<Database> = createTxRunner(opened.kysely, {
    ...(options.log ? { log: options.log } : {}),
    ...(options.slowMs === undefined ? {} : { slowMs: options.slowMs }),
    ensureHead: (userId) => ensureHead(runner, userId, now()),
  });
  return Object.freeze({
    ...runner,
    dialect: opened.dialect,
    kysely: opened.kysely,
    destroy: () => opened.kysely.destroy(),
  });
}

/** Opens the database of `DATABASE_URL` (API §9.4) and returns `ctx.db`. */
export function createDb(env: DbEnv, options: DbOptions & OpenKyselyOptions = {}): Db {
  return dbFromKysely(openKysely<Database>(env, options), options);
}
