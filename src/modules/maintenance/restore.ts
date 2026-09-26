/**
 * Restoring a SQLite backup (DESIGN §7.6 "restore FILE" step 3, §3.15 item 3; PLAN T3.1). The server must be stopped:
 * the host CLI runs `stop app`, then `run --rm --no-deps -T app melogold restore --from - --yes < db.sqlite`.
 *
 * {@link restoreSqlite}:
 * 1. the incoming copy passes `integrity_check`, is a Melogold database, and has no migration this image does not
 *    know (an older copy is fine: it is migrated at step 5); it gets `restore_pending = '1'` if it lacks it;
 * 2. the current database is checkpointed (its WAL folded in) and moved with any `-wal`/`-shm` to
 *    `<DATA_DIR>/.pre-restore/<time>/`;
 * 3. the copy is renamed into place (same volume: atomic);
 * 4. the database is opened like a server start: migrations, schema check, `server_id`;
 * 5. every user's epoch is rotated and the flag cleared (`applyPendingRestore`), so every device merges silently.
 *
 * If the process dies after step 3 the flag is still set, and the next start of the server rotates the epochs itself.
 */
import { existsSync, mkdirSync, openSync, closeSync, fsyncSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Env } from "../../config/env.ts";
import type { AppLogger } from "../../context.ts";
import { createDb } from "../../db/index.ts";
import { prepareDatabase } from "../../db/migrate.ts";
import type { Clock } from "../../lib/clock.ts";
import { formatIso } from "../../lib/time.ts";
import { applyPendingRestore, initServerIdentity, markRestorePending } from "../server/server.service.ts";
import { BackupError, inspectSqliteCopy, openSqliteFile, postgresRefusal } from "./backup.ts";
import { checkpointSqlite } from "./maintenance.repository.ts";

/** Where the replaced database is kept (inside the data volume). */
export const PRE_RESTORE_DIR = ".pre-restore";

export type RestoreReport = Readonly<{
  /** Directory the previous database was moved to, or `null` when there was none. */
  previous: string | null;
  serverId: string;
  rotatedUsers: number;
  /** Migrations applied to bring an older copy up to this image. */
  migrated: readonly string[];
}>;

function fsyncDirectory(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Not every file system lets a directory be opened for fsync; the rename is still atomic.
  }
}

/**
 * Steps 1–5 above; `source` is a file inside the data volume (the caller wrote the incoming copy there).
 * @throws BackupError when the copy is unusable or the database is not SQLite; nothing is replaced then.
 */
export async function restoreSqlite(
  input: Readonly<{ env: Env; log: AppLogger; clock: Clock; source: string }>,
): Promise<RestoreReport> {
  const { env, log, clock, source } = input;
  const url = env.DATABASE_URL;
  if (url.dialect !== "sqlite") throw postgresRefusal("restore");
  if (url.memory) throw new BackupError("an in-memory database cannot be restored");
  const target = url.path;

  // 1. The incoming copy.
  const report = await inspectSqliteCopy(env, source, log);
  if (report.problems.length > 0) {
    throw new BackupError(`the backup failed integrity_check: ${report.problems.join("; ")}`);
  }
  if (report.migrations.applied === 0) throw new BackupError("the file is not a Melogold database");
  if (report.migrations.unknown.length > 0) {
    throw new BackupError(
      `the backup comes from a newer server (unknown migrations: ${report.migrations.unknown.join(", ")}); ` +
        "restore it with that version's image",
    );
  }
  if (!report.restorePending) {
    const copy = openSqliteFile(env, source, log);
    try {
      await markRestorePending(copy);
    } finally {
      await copy.destroy();
    }
  }

  // 2. The current database out of the way.
  let previous: string | null = null;
  if (existsSync(target)) {
    const current = openSqliteFile(env, target, log);
    try {
      await current.run((q) => checkpointSqlite(q));
    } finally {
      await current.destroy();
    }
    previous = join(env.DATA_DIR, PRE_RESTORE_DIR, formatIso(clock.now()).replace(/[:.]/g, "-"));
    mkdirSync(previous, { recursive: true, mode: 0o700 });
    for (const suffix of ["", "-wal", "-shm"]) {
      const file = `${target}${suffix}`;
      if (existsSync(file)) renameSync(file, join(previous, `${basename(target)}${suffix}`));
    }
  }

  // 3. The copy into place.
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  renameSync(source, target);
  fsyncDirectory(dirname(target));

  // 4–5. Open like a server start, then rotate every epoch.
  const db = createDb(env, { log, now: () => clock.now() });
  try {
    const prepared = await prepareDatabase(db, { log, migrateOnStart: true, schemaCheck: env.SCHEMA_CHECK });
    const migrated = prepared.migration.status === "migrated" ? prepared.migration.executed : [];
    const serverId = await initServerIdentity(db, clock.now());
    const outcome = await applyPendingRestore(db, {
      now: clock.now(),
      graceDays: env.RESTORE_REFRESH_GRACE_DAYS,
      log,
    });
    return Object.freeze({ previous, serverId, rotatedUsers: outcome?.rotatedUsers ?? 0, migrated });
  } finally {
    await db.destroy();
  }
}
