/**
 * Transactions: `db.read`, `db.write`, `db.run` (DESIGN §6.2, API §9.4, docs/database.md).
 *
 * | Call       | PostgreSQL                              | SQLite                                              |
 * | ---------- | --------------------------------------- | --------------------------------------------------- |
 * | `write(fn)`| `START TRANSACTION ISOLATION LEVEL READ COMMITTED` | `BEGIN IMMEDIATE` (the only writer, across processes) |
 * | `read(fn)` | `… REPEATABLE READ READ ONLY`           | `BEGIN` (WAL snapshot) with `PRAGMA query_only = ON` |
 * | `run(fn)`  | one statement, autocommit               | one statement, autocommit                           |
 *
 * **No nesting.** A `read`/`write`/`run` started inside another one throws {@link NestedDbAccessError}: SQLite has one
 * connection behind a mutex, so the inner call would wait forever for the outer one. The check uses
 * `AsyncLocalStorage`, so it also catches calls made deep inside services. The scope is closed when the call ends:
 * a timer or listener created inside a transaction keeps the async context, but once that transaction is over its
 * `db.*` calls are not nested and run normally.
 *
 * **Missing head.** `lockUser`/`readHead` throw {@link MissingHeadError} when `sync_heads` has no row for the user.
 * The runner then rolls back, creates the row in a short write transaction (`ensureHead`, API §9.5) and runs the
 * callback once more. The callback therefore must not have side effects before its first statement.
 *
 * **Budget.** A transaction longer than 2 s is logged as a warning (DESIGN §6.2): nothing but `q` may be awaited
 * inside, never the network or argon2.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { sql } from "kysely";
import type { Kysely, Transaction } from "kysely";

export type TxKind = "read" | "write" | "run";

/** State of the database access in progress on this async path. */
export type TxScope = {
  readonly kind: TxKind;
  /** Statements executed so far (counted by `StatementCounterPlugin`). */
  statements: number;
  savepoints: number;
  /** Set when the call has ended; async resources created inside it still see the scope, which then means nothing. */
  closed: boolean;
};

const scopes = new AsyncLocalStorage<TxScope>();

/** The database access this code runs inside, if any (a scope whose call has ended is no scope). */
export function currentTxScope(): TxScope | undefined {
  const scope = scopes.getStore();
  return scope?.closed === false ? scope : undefined;
}

export class NestedDbAccessError extends Error {
  constructor(inner: TxKind | "migrate" | "kysely", outer: TxKind) {
    super(
      `db.${inner} called inside db.${outer}: database calls must not nest ` +
        "(SQLite would wait forever for its only connection); finish the outer call first",
    );
    this.name = "NestedDbAccessError";
  }
}

/** Thrown by `lockUser`/`readHead` when `sync_heads` has no row for the user; handled by the runner. */
export class MissingHeadError extends Error {
  readonly userId: string;

  constructor(userId: string) {
    super(`sync_heads has no row for user ${userId}`);
    this.name = "MissingHeadError";
    this.userId = userId;
  }
}

/** Misuse of a transaction rule that the code can detect (e.g. `lockUser` not first). */
export class TxRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TxRuleError";
  }
}

/** Throws when called inside `db.read`/`db.write`/`db.run` (used by the migration runner and similar tools). */
export function assertOutsideTx(what: TxKind | "migrate" | "kysely"): void {
  const outer = currentTxScope();
  if (outer) throw new NestedDbAccessError(what, outer.kind);
}

/**
 * Asserts that the caller is the first statement of a `db.write` callback (`lockUser`, API §9.5).
 * @param what the helper's name for the message.
 */
export function assertFirstStatementOfWrite(what: string): void {
  const scope = currentTxScope();
  if (scope?.kind !== "write") throw new TxRuleError(`${what} must be called inside db.write`);
  if (scope.statements !== 0) {
    throw new TxRuleError(`${what} must be the first statement of the transaction (${scope.statements} ran before)`);
  }
}

export type TxLogger = {
  warn(details: object, message: string): void;
};

export type TxRunnerOptions = Readonly<{
  log?: TxLogger;
  /** Transactions longer than this are logged (DESIGN §6.2: 2 s). */
  slowMs?: number;
  /**
   * Creates the missing `sync_heads` row in its own write transaction; `false` when the user does not exist.
   * Without it, {@link MissingHeadError} propagates.
   */
  ensureHead?: (userId: string) => Promise<boolean>;
}>;

export type TxRunner<DB> = Readonly<{
  read<T>(fn: (q: Transaction<DB>) => Promise<T>): Promise<T>;
  write<T>(fn: (q: Transaction<DB>) => Promise<T>): Promise<T>;
  run<T>(fn: (q: Kysely<DB>) => Promise<T>): Promise<T>;
}>;

export const SLOW_TRANSACTION_MS = 2000;

export function createTxRunner<DB>(kysely: Kysely<DB>, options: TxRunnerOptions = {}): TxRunner<DB> {
  const slowMs = options.slowMs ?? SLOW_TRANSACTION_MS;
  const log = options.log;

  async function inScope<T>(kind: TxKind, body: () => Promise<T>): Promise<T> {
    assertOutsideTx(kind);
    const scope: TxScope = { kind, statements: 0, savepoints: 0, closed: false };
    const started = performance.now();
    try {
      return await scopes.run(scope, body);
    } finally {
      scope.closed = true;
      const durationMs = Math.round(performance.now() - started);
      if (durationMs > slowMs) {
        log?.warn({ kind, durationMs, statements: scope.statements }, "slow database transaction");
      }
    }
  }

  async function withHeadRetry<T>(attempt: () => Promise<T>): Promise<T> {
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof MissingHeadError) || !options.ensureHead) throw error;
      const exists = await options.ensureHead(error.userId);
      if (!exists) throw error;
      return await attempt();
    }
  }

  return Object.freeze({
    read: <T>(fn: (q: Transaction<DB>) => Promise<T>) =>
      withHeadRetry(() =>
        inScope("read", () =>
          kysely.transaction().setIsolationLevel("repeatable read").setAccessMode("read only").execute(fn),
        ),
      ),
    write: <T>(fn: (q: Transaction<DB>) => Promise<T>) =>
      withHeadRetry(() =>
        inScope("write", () =>
          kysely.transaction().setIsolationLevel("read committed").setAccessMode("read write").execute(fn),
        ),
      ),
    run: <T>(fn: (q: Kysely<DB>) => Promise<T>) => inScope("run", () => fn(kysely)),
  });
}

/**
 * Runs `fn` inside a savepoint of the current `db.write` transaction: when `fn` throws, only its statements are
 * rolled back and the transaction stays usable (in PostgreSQL an error otherwise aborts the whole transaction with
 * 25P02). This is the escape hatch of docs/database.md; `ON CONFLICT` is preferred wherever it works.
 */
export async function withSavepoint<DB, T>(q: Transaction<DB>, fn: () => Promise<T>): Promise<T> {
  const scope = currentTxScope();
  if (scope?.kind !== "write") throw new TxRuleError("withSavepoint must be called inside db.write");
  scope.savepoints += 1;
  const name = sql.id(`melogold_sp_${scope.savepoints}`);
  await sql`SAVEPOINT ${name}`.execute(q);
  let result: T;
  try {
    result = await fn();
  } catch (error) {
    await sql`ROLLBACK TO SAVEPOINT ${name}`.execute(q);
    await sql`RELEASE SAVEPOINT ${name}`.execute(q);
    throw error;
  }
  await sql`RELEASE SAVEPOINT ${name}`.execute(q);
  return result;
}
