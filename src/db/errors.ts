/**
 * Driver errors → API error codes (API §2.4, DESIGN §6.2). This is the only module that knows SQLSTATE values and
 * SQLite result codes; the HTTP error handler asks {@link translateDbError} and answers `500 internal_error` for
 * everything it returns `null` for.
 *
 * | Error                                                              | Answer                                   |
 * | ------------------------------------------------------------------ | ---------------------------------------- |
 * | unique / FK (PG 23505/23503, SQLite `SQLITE_CONSTRAINT_*`)          | the service translates it, otherwise 500 |
 * | PG 40P01, 40001, 55P03, 57014, 53300; SQLite `SQLITE_BUSY`          | 503 `server_busy`, Retry-After 1..2      |
 * | PG 08xxx, 57P01 (and no connection at all)                         | 503 `unavailable`, Retry-After 5         |
 * | PG 53100; SQLite `SQLITE_FULL`                                     | 503 `storage_full`, Retry-After 600      |
 * | PG 22021 (NUL), 22003 (overflow)                                   | 500: must not happen (API §1.4), a bug   |
 *
 * Constraint violations are never caught inside a transaction (docs/database.md): a service that wants its own code
 * checks {@link constraintViolation} on the error that `db.write` rejected with, after the rollback.
 */

export type DbErrorCode = "server_busy" | "unavailable" | "storage_full";

export type DbErrorTranslation = Readonly<{
  statusCode: 503;
  code: DbErrorCode;
  retryAfterSeconds: number;
}>;

export type ConstraintKind = "unique" | "foreign_key";

export type ConstraintViolation = Readonly<{
  kind: ConstraintKind;
  /** Table named by the driver, when it names one (PostgreSQL always, SQLite for unique violations). */
  table: string | null;
  /** Columns of the violated key, when the driver names them. */
  columns: readonly string[];
  /** PostgreSQL constraint name (`users_login_key`); SQLite has none. */
  constraint: string | null;
}>;

export const RETRY_AFTER_UNAVAILABLE_SECONDS = 5;
export const RETRY_AFTER_STORAGE_FULL_SECONDS = 600;

const PG_BUSY = new Set(["40P01", "40001", "55P03", "57014", "53300"]);
/** 57P01 admin_shutdown (API §2.4); 57P03 cannot_connect_now (server starting up) means the same to a client. */
const PG_UNAVAILABLE = new Set(["57P01", "57P03"]);
const PG_STORAGE_FULL = new Set(["53100"]);

/** Socket-level failures of `pg` (no SQLSTATE): the database cannot be reached. */
const NETWORK_ERRNO = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
]);
const PG_CONNECTION_MESSAGES = [
  "Connection terminated unexpectedly",
  "Connection terminated due to connection timeout",
  "Client has encountered a connection error and is not queryable",
];
/** `pg.Pool` waited `connectionTimeoutMillis` for a free client: the pool is saturated. */
const PG_POOL_TIMEOUT_MESSAGE = "timeout exceeded when trying to connect";

type ErrorLike = { code?: unknown; message?: unknown; cause?: unknown };

function isObject(value: unknown): value is ErrorLike {
  return typeof value === "object" && value !== null;
}

/** The error and its `cause` chain (bounded), outermost first. */
function chain(error: unknown): ErrorLike[] {
  const errors: ErrorLike[] = [];
  let current: unknown = error;
  while (isObject(current) && errors.length < 8 && !errors.includes(current)) {
    errors.push(current);
    current = current.cause;
  }
  return errors;
}

function codeOf(error: ErrorLike): string | null {
  return typeof error.code === "string" ? error.code : null;
}

function messageOf(error: ErrorLike): string {
  return typeof error.message === "string" ? error.message : "";
}

function isSqliteError(error: ErrorLike): boolean {
  return codeOf(error)?.startsWith("SQLITE_") === true;
}

/** SQLSTATE of a `pg` `DatabaseError`: five characters, digits and uppercase letters. */
function sqlState(error: ErrorLike): string | null {
  const code = codeOf(error);
  return code !== null && /^[0-9A-Z]{5}$/.test(code) && !isSqliteError(error) ? code : null;
}

function busyRetryAfter(random: () => number): number {
  return random() < 0.5 ? 1 : 2;
}

/**
 * Maps a database driver error to a 503 answer, or `null` when the error is not one of API §2.4's transient
 * conditions (constraint violations, bugs and anything unknown: `500 internal_error`).
 * @param random jitter source for `server_busy`'s `Retry-After: 1..2` (injected in tests).
 */
export function translateDbError(error: unknown, random: () => number = Math.random): DbErrorTranslation | null {
  for (const candidate of chain(error)) {
    const code = codeOf(candidate);
    if (code !== null && isSqliteError(candidate)) {
      if (code === "SQLITE_BUSY" || code.startsWith("SQLITE_BUSY_") || code.startsWith("SQLITE_LOCKED")) {
        return { statusCode: 503, code: "server_busy", retryAfterSeconds: busyRetryAfter(random) };
      }
      if (code === "SQLITE_FULL") {
        return { statusCode: 503, code: "storage_full", retryAfterSeconds: RETRY_AFTER_STORAGE_FULL_SECONDS };
      }
      return null;
    }
    const state = sqlState(candidate);
    if (state !== null) {
      if (PG_BUSY.has(state)) {
        return { statusCode: 503, code: "server_busy", retryAfterSeconds: busyRetryAfter(random) };
      }
      if (state.startsWith("08") || PG_UNAVAILABLE.has(state)) {
        return { statusCode: 503, code: "unavailable", retryAfterSeconds: RETRY_AFTER_UNAVAILABLE_SECONDS };
      }
      if (PG_STORAGE_FULL.has(state)) {
        return { statusCode: 503, code: "storage_full", retryAfterSeconds: RETRY_AFTER_STORAGE_FULL_SECONDS };
      }
      return null;
    }
    if (code !== null && NETWORK_ERRNO.has(code)) {
      return { statusCode: 503, code: "unavailable", retryAfterSeconds: RETRY_AFTER_UNAVAILABLE_SECONDS };
    }
    const message = messageOf(candidate);
    if (message === PG_POOL_TIMEOUT_MESSAGE) {
      return { statusCode: 503, code: "server_busy", retryAfterSeconds: busyRetryAfter(random) };
    }
    if (PG_CONNECTION_MESSAGES.some((known) => message.startsWith(known))) {
      return { statusCode: 503, code: "unavailable", retryAfterSeconds: RETRY_AFTER_UNAVAILABLE_SECONDS };
    }
  }
  return null;
}

const SQLITE_UNIQUE_MESSAGE = /^UNIQUE constraint failed: (.+)$/;
const PG_KEY_DETAIL = /^Key \((.+?)\)=/;

function sqliteUniqueColumns(message: string): { table: string | null; columns: string[] } {
  const match = SQLITE_UNIQUE_MESSAGE.exec(message);
  if (!match?.[1]) return { table: null, columns: [] };
  const qualified = match[1].split(",").map((part) => part.trim());
  const table = qualified[0]?.split(".")[0] ?? null;
  return { table, columns: qualified.map((part) => part.slice(part.indexOf(".") + 1)) };
}

/**
 * Recognizes a unique or foreign key violation of either driver. Services use it at the transaction boundary
 * (after `db.write` rejected) to answer with their own code (`login_taken`, …); API §2.4.
 */
export function constraintViolation(error: unknown): ConstraintViolation | null {
  for (const candidate of chain(error)) {
    const code = codeOf(candidate);
    if (code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
      const { table, columns } = sqliteUniqueColumns(messageOf(candidate));
      return { kind: "unique", table, columns, constraint: null };
    }
    if (code === "SQLITE_CONSTRAINT_FOREIGNKEY") {
      return { kind: "foreign_key", table: null, columns: [], constraint: null };
    }
    if (code === "23505" || code === "23503") {
      const record = candidate as ErrorLike & { table?: unknown; constraint?: unknown; detail?: unknown };
      const detail = typeof record.detail === "string" ? record.detail : "";
      const keyColumns = PG_KEY_DETAIL.exec(detail)?.[1];
      return {
        kind: code === "23505" ? "unique" : "foreign_key",
        table: typeof record.table === "string" ? record.table : null,
        columns: keyColumns ? keyColumns.split(",").map((column) => column.trim()) : [],
        constraint: typeof record.constraint === "string" ? record.constraint : null,
      };
    }
  }
  return null;
}

export function isUniqueViolation(error: unknown): boolean {
  return constraintViolation(error)?.kind === "unique";
}

export function isForeignKeyViolation(error: unknown): boolean {
  return constraintViolation(error)?.kind === "foreign_key";
}
