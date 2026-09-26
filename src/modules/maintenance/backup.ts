/**
 * The SQLite copy of a backup and its check (DESIGN §7.6 "SQLite, онлайн", §3.15 item 1; PLAN T3.1). The host CLI
 * packs the copy with `manifest.json` and `.env` into `melogold-backup-….tar.gz`; PostgreSQL is dumped by the host
 * CLI with `pg_dump` in the postgres container, not here.
 *
 * {@link createSqliteBackup}, while the server runs:
 * 1. `VACUUM INTO <DATA_DIR>/.tmp/backup-<id>.sqlite`: a consistent snapshot, compacted, that never blocks the server
 *    longer than one read transaction;
 * 2. `PRAGMA integrity_check` of the copy;
 * 3. `restore_pending = '1'` **in the copy**: any restore of it, even by hand, rotates every epoch at the next start.
 *
 * {@link inspectSqliteCopy}: what a copy holds (`verify-backup`, and `restore` before it replaces anything).
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "../../config/env.ts";
import { createDb } from "../../db/index.ts";
import type { Db, DbLogger } from "../../db/index.ts";
import { readMigrationState } from "../../db/migrate.ts";
import { newId } from "../../lib/ids.ts";
import { isRestorePending, markRestorePending } from "../server/server.service.ts";
import { integrityProblemsSqlite, tableCounts, vacuumIntoSqlite } from "./maintenance.repository.ts";
import type { TableCounts } from "./maintenance.repository.ts";

/** Working directory of copies inside the data volume (the image's root is read-only, DESIGN §7.1). */
export const BACKUP_TMP_DIR = ".tmp";

/** A backup or restore that cannot go on; the message says why. */
export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupError";
  }
}

/** A fresh file name in `<DATA_DIR>/.tmp` (the directory is created). */
export function tempCopyPath(env: Pick<Env, "DATA_DIR">, prefix: string): string {
  const dir = join(env.DATA_DIR, BACKUP_TMP_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, `${prefix}-${newId()}.sqlite`);
}

/** Opens another SQLite file with the settings of `env` (same PRAGMAs as the server's database). */
export function openSqliteFile(env: Env, file: string, log?: DbLogger): Db {
  return createDb(
    { ...env, DATABASE_URL: { dialect: "sqlite", url: `sqlite://${file}`, path: file, memory: false } },
    log ? { log } : {},
  );
}

/** The refusal of a SQLite-only command on PostgreSQL. */
export function postgresRefusal(what: string): BackupError {
  return new BackupError(
    `${what} of PostgreSQL is done by the host command (melogold ${what} on the server, pg_dump and psql in the ` +
      "postgres container), not inside the image",
  );
}

export function assertSqlite(db: Pick<Db, "dialect">, what: string): void {
  if (db.dialect !== "sqlite") throw postgresRefusal(what);
}

/**
 * Steps 1–3 above. The caller streams the returned file and deletes it.
 * @throws BackupError on PostgreSQL or when the copy is damaged (the copy is removed then).
 */
export async function createSqliteBackup(input: Readonly<{ env: Env; db: Db; log?: DbLogger }>): Promise<string> {
  assertSqlite(input.db, "backup");
  const file = tempCopyPath(input.env, "backup");
  try {
    await input.db.run((q) => vacuumIntoSqlite(q, file));
    const copy = openSqliteFile(input.env, file, input.log);
    try {
      const problems = await copy.run((q) => integrityProblemsSqlite(q));
      if (problems.length > 0) throw new BackupError(`the copy failed integrity_check: ${problems.join("; ")}`);
      await markRestorePending(copy);
    } finally {
      await copy.destroy();
    }
    return file;
  } catch (error) {
    rmSync(file, { force: true });
    throw error;
  }
}

export type CopyReport = Readonly<{
  /** `[]` when `integrity_check` is ok. */
  problems: readonly string[];
  /** Migrations the copy has, those this image would still apply, and those this image does not know. */
  migrations: Readonly<{ applied: number; pending: readonly string[]; unknown: readonly string[] }>;
  /** Whether the copy carries the restore flag (every Melogold backup does). */
  restorePending: boolean;
  counts: TableCounts | null;
}>;

/** Opens a copy read-only in effect (no writes) and reports what it holds. */
export async function inspectSqliteCopy(env: Env, file: string, log?: DbLogger): Promise<CopyReport> {
  const copy = openSqliteFile(env, file, log);
  try {
    const problems = await copy.run((q) => integrityProblemsSqlite(q));
    const state = await readMigrationState(copy);
    const usable = problems.length === 0 && state.applied.length > 0;
    return Object.freeze({
      problems,
      migrations: Object.freeze({ applied: state.applied.length, pending: state.pending, unknown: state.unknown }),
      restorePending: usable ? await isRestorePending(copy) : false,
      counts: usable ? await copy.run((q) => tableCounts(q)) : null,
    });
  } finally {
    await copy.destroy();
  }
}
