/**
 * SQLite dialect (better-sqlite3), API §9.4:
 * - one connection; Kysely serializes its use with a mutex;
 * - PRAGMAs on open: `busy_timeout`, `auto_vacuum=INCREMENTAL` for a new database (API §9.1 rule 8), `journal_mode=WAL`,
 *   `synchronous`, `foreign_keys=ON`, `temp_store=MEMORY`, `cache_size=-16000`, `journal_size_limit=67108864`,
 *   `optimize=0x10002` (the scheduler repeats {@link optimizeSqlite} every 6 h);
 * - `db.write` → `BEGIN IMMEDIATE`: the write lock is taken at `BEGIN`, so other processes (CLI, backup) wait
 *   `busy_timeout` there and a transaction never fails half-way with `SQLITE_BUSY` on its first write;
 * - `db.read` → `BEGIN` (deferred: a WAL snapshot at the first read) under `PRAGMA query_only = ON`;
 * - migrations run in one transaction: the adapter reports `supportsTransactionalDdl = true` (SQLite has
 *   transactional DDL; Kysely's default adapter says `false`).
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { CompiledQuery, SqliteAdapter, SqliteDriver, SqliteIntrospector, SqliteQueryCompiler, sql } from "kysely";
import type { DatabaseConnection, Dialect, QueryExecutorProvider, TransactionSettings } from "kysely";

export type SqliteOptions = Readonly<{
  /** File path, or `:memory:` (tests and OpenAPI generation only). */
  path: string;
  busyTimeoutMs: number;
  synchronous: "FULL" | "NORMAL";
}>;

export class SqliteOpenError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SqliteOpenError";
  }
}

/** Opens the database file (creating its directory) and applies the PRAGMAs of API §9.4. */
export function openSqlite(options: SqliteOptions): Database.Database {
  const memory = options.path === ":memory:";
  if (!memory) mkdirSync(dirname(resolve(options.path)), { recursive: true });
  const database = new Database(options.path, { timeout: options.busyTimeoutMs });
  try {
    database.pragma(`busy_timeout = ${Math.trunc(options.busyTimeoutMs)}`);
    const objects = database.prepare("SELECT count(*) AS n FROM sqlite_schema").get() as { n: number };
    if (objects.n === 0) database.pragma("auto_vacuum = INCREMENTAL");
    const journalMode = database.pragma("journal_mode = WAL", { simple: true }) as string;
    if (!memory && journalMode.toLowerCase() !== "wal") {
      throw new SqliteOpenError(`journal_mode=WAL could not be enabled (got ${journalMode})`);
    }
    database.pragma(`synchronous = ${options.synchronous}`);
    database.pragma("foreign_keys = ON");
    database.pragma("temp_store = MEMORY");
    database.pragma("cache_size = -16000");
    database.pragma("journal_size_limit = 67108864");
    database.pragma("optimize = 0x10002");
  } catch (error) {
    database.close();
    throw error;
  }
  return database;
}

/** `PRAGMA optimize` (API §9.4: at open and every 6 hours). */
export async function optimizeSqlite(q: QueryExecutorProvider): Promise<void> {
  await sql`PRAGMA optimize`.execute(q);
}

const raw = (text: string) => CompiledQuery.raw(text);

/**
 * `BEGIN IMMEDIATE` for writes; deferred `BEGIN` under `query_only` for reads.
 *
 * SQLite rolls a transaction back by itself on some errors (`SQLITE_FULL`, `SQLITE_IOERR`, `SQLITE_NOMEM`, …). Kysely
 * then issues `ROLLBACK`, which fails with "no transaction is active" and would replace the original error (and turn
 * `503 storage_full` into a 500), so the rollback is skipped when no transaction is open.
 */
class MelogoldSqliteDriver extends SqliteDriver {
  readonly #database: Database.Database;
  #readOnly = false;

  constructor(database: Database.Database) {
    super({ database });
    this.#database = database;
  }

  // Kysely passes the settings although SqliteDriver's declaration omits the parameter.
  override async beginTransaction(connection: DatabaseConnection, settings?: TransactionSettings): Promise<void> {
    if (settings?.accessMode === "read only") {
      await connection.executeQuery(raw("PRAGMA query_only = ON"));
      this.#readOnly = true;
      try {
        await connection.executeQuery(raw("BEGIN"));
      } catch (error) {
        await this.#leaveReadOnly(connection);
        throw error;
      }
      return;
    }
    await connection.executeQuery(raw("BEGIN IMMEDIATE"));
  }

  override async commitTransaction(connection: DatabaseConnection): Promise<void> {
    try {
      await super.commitTransaction(connection);
    } finally {
      await this.#leaveReadOnly(connection);
    }
  }

  override async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    try {
      if (this.#database.inTransaction) await super.rollbackTransaction(connection);
    } finally {
      await this.#leaveReadOnly(connection);
    }
  }

  async #leaveReadOnly(connection: DatabaseConnection): Promise<void> {
    if (!this.#readOnly) return;
    this.#readOnly = false;
    await connection.executeQuery(raw("PRAGMA query_only = OFF"));
  }
}

class MelogoldSqliteAdapter extends SqliteAdapter {
  override get supportsTransactionalDdl(): boolean {
    return true;
  }
}

/** Kysely dialect over an opened database; `destroy()` closes it. */
export function createSqliteDialect(database: Database.Database): Dialect {
  return {
    createAdapter: () => new MelogoldSqliteAdapter(),
    createDriver: () => new MelogoldSqliteDriver(database),
    createIntrospector: (db) => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  };
}
