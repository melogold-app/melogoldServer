/**
 * `backup`, `restore`, `verify-backup` and `sync rotate-epoch` (DESIGN §7.6, §3.15; PLAN T3.1). SQLite only for the
 * first three: PostgreSQL is dumped and restored by the host CLI (`pg_dump`/`psql` in the postgres container), which
 * then runs `melogold sync rotate-epoch --all` here.
 *
 * `-` means stdout (`backup --out -`) or stdin (`restore --from -`), for `docker compose exec -T app melogold backup
 * --out - > db.sqlite` and `docker compose run --rm -T app melogold restore --from - --yes < db.sqlite`. Incoming copies
 * are first written into `<DATA_DIR>/.tmp`, so the final rename stays on the data volume.
 */
import { copyFileSync, createReadStream, createWriteStream, rmSync, statSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { Env } from "../config/env.ts";
import { createDb } from "../db/index.ts";
import { isAppError } from "../http/errors.ts";
import { findAccount } from "../modules/account/admin.ts";
import { BackupError, createSqliteBackup, inspectSqliteCopy, tempCopyPath } from "../modules/maintenance/backup.ts";
import type { CopyReport } from "../modules/maintenance/backup.ts";
import { restoreSqlite } from "../modules/maintenance/restore.ts";
import { markRestorePending, rotateUserEpoch } from "../modules/server/server.service.ts";
import { systemClock } from "../lib/clock.ts";
import { CliError, EXIT_FAILURE, EXIT_OK } from "./io.ts";
import type { CliOutput } from "./io.ts";
import type { Prompter } from "./password.ts";
import { withRuntime } from "./runtime.ts";
import type { OpenRuntimeOptions } from "./runtime.ts";

/** Chunks of `backup --out -`. */
const STREAM_CHUNK = 1 << 20;

function asCliError(error: unknown): unknown {
  if (error instanceof BackupError) return new CliError(error.message);
  if (isAppError(error)) return new CliError(error.message);
  return error;
}

/** Copies `from` (a path, or `-` for `stdin`) into a fresh file in `<DATA_DIR>/.tmp` and returns its path. */
async function incomingCopy(env: Env, from: string, stdin: NodeJS.ReadableStream, prefix: string): Promise<string> {
  const file = tempCopyPath(env, prefix);
  try {
    if (from === "-") await pipeline(stdin, createWriteStream(file, { mode: 0o600 }));
    else copyFileSync(from, file);
    if (statSync(file).size === 0) throw new CliError("the backup is empty");
    return file;
  } catch (error) {
    rmSync(file, { force: true });
    if (error instanceof CliError) throw error;
    throw new CliError(
      `cannot read ${from === "-" ? "stdin" : from}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** `backup --out <file|->`: the checked SQLite copy with the restore flag, to a file (0600) or stdout. */
export async function backupCommand(
  env: Env,
  output: CliOutput,
  options: OpenRuntimeOptions,
  out: string,
): Promise<number> {
  const db = createDb(env, { log: options.log });
  let file: string | null = null;
  try {
    file = await createSqliteBackup({ env, db, log: options.log });
    const size = statSync(file).size;
    if (out === "-") {
      const reader = createReadStream(file, { highWaterMark: STREAM_CHUNK });
      for await (const chunk of reader) await output.outBytes(chunk as Buffer);
      output.err(`melogold: backup written to stdout (${size} bytes)\n`);
    } else {
      copyFileSync(file, out);
      await chmod(out, 0o600);
      output.out(`backup written to ${out} (${size} bytes)\n`);
    }
    return EXIT_OK;
  } catch (error) {
    throw asCliError(error);
  } finally {
    if (file !== null) rmSync(file, { force: true });
    await db.destroy();
  }
}

function copyReportText(report: CopyReport): string {
  const counts = report.counts;
  const lines = [
    `integrity:    ${report.problems.length === 0 ? "ok" : report.problems.join("; ")}`,
    `migrations:   ${report.migrations.applied}` +
      (report.migrations.pending.length > 0
        ? `, this image would apply: ${report.migrations.pending.join(", ")}`
        : "") +
      (report.migrations.unknown.length > 0 ? `, NEWER than this image: ${report.migrations.unknown.join(", ")}` : ""),
    `restore flag: ${report.restorePending ? "set" : "not set (not made by melogold backup)"}`,
    counts === null
      ? "rows:         —"
      : `rows:         ${counts.users} accounts, ${counts.devices} devices, ${counts.likes} likes, ` +
        `${counts.playlists} playlists, ${counts.playEvents} plays, ${counts.lyrics} lyrics`,
  ];
  return `${lines.join("\n")}\n`;
}

/** `verify-backup --from <file|-> [--json]`: exit 1 when the copy cannot be restored by this image. */
export async function verifyBackupCommand(
  env: Env,
  output: CliOutput,
  options: OpenRuntimeOptions,
  input: Readonly<{ from: string; json: boolean; stdin: NodeJS.ReadableStream }>,
): Promise<number> {
  if (env.DATABASE_URL.dialect !== "sqlite")
    throw asCliError(
      new BackupError("verify-backup here checks SQLite copies; PostgreSQL dumps are verified by the host command"),
    );
  const file = await incomingCopy(env, input.from, input.stdin, "verify");
  try {
    const report = await inspectSqliteCopy(env, file, options.log);
    output.out(input.json ? `${JSON.stringify(report)}\n` : copyReportText(report));
    const restorable =
      report.problems.length === 0 && report.migrations.applied > 0 && report.migrations.unknown.length === 0;
    return restorable ? EXIT_OK : EXIT_FAILURE;
  } finally {
    rmSync(file, { force: true });
  }
}

/**
 * `restore --from <file|-> [--yes]`: replaces the database with the copy and rotates every epoch. The server must be
 * stopped. Without `--yes` the word `restore` must be typed.
 */
export async function restoreCommand(
  env: Env,
  output: CliOutput,
  options: OpenRuntimeOptions,
  prompter: Prompter,
  input: Readonly<{ from: string; yes: boolean; stdin: NodeJS.ReadableStream }>,
): Promise<number> {
  if (env.DATABASE_URL.dialect !== "sqlite")
    throw asCliError(
      new BackupError("restore of PostgreSQL is done by the host command (melogold restore on the server)"),
    );
  if (!input.yes) {
    const typed = await prompter.visible(
      "This replaces the database of this server with the backup (the server must be stopped). Type restore to go on: ",
    );
    if (typed.trim() !== "restore") throw new CliError("cancelled");
  }
  const source = await incomingCopy(env, input.from, input.stdin, "restore");
  try {
    const report = await restoreSqlite({ env, log: options.log, clock: systemClock, source });
    output.out(
      `restored server ${report.serverId}: ${report.rotatedUsers} accounts got a new sync epoch, their devices merge silently\n` +
        (report.migrated.length > 0 ? `migrated the copy: ${report.migrated.join(", ")}\n` : "") +
        (report.previous === null ? "" : `the previous database is kept in ${report.previous}\n`),
    );
    return EXIT_OK;
  } catch (error) {
    throw asCliError(error);
  } finally {
    rmSync(source, { force: true });
  }
}

/**
 * `sync rotate-epoch --all|<login>`: `--all` sets the restore flag, so the next server start gives every account a
 * new epoch (DESIGN §3.15 item 4, after a snapshot rollback); a login gets its new epoch at once.
 */
export async function rotateEpochCommand(
  env: Env,
  output: CliOutput,
  options: OpenRuntimeOptions,
  target: Readonly<{ all: true } | { login: string }>,
): Promise<number> {
  try {
    return await withRuntime(env, options, async (runtime) => {
      if ("all" in target) {
        await markRestorePending(runtime.db);
        output.out("every account gets a new sync epoch at the next server start: restart the server now\n");
        return EXIT_OK;
      }
      const account = await findAccount(runtime, target.login);
      await rotateUserEpoch(runtime.db, account.id, runtime.clock.now());
      output.out(`${account.login} got a new sync epoch: its devices merge silently at their next sync\n`);
      return EXIT_OK;
    });
  } catch (error) {
    throw asCliError(error);
  }
}
