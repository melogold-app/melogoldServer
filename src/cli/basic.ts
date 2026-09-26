/**
 * The small commands of the CLI (DESIGN §7.4, PLAN T3.1): `migrate`, `info [--json]`, `check-config`, `openapi`,
 * `qr [url]`, `jobs run <name>`, `secret rotate`.
 */
import { accessSync, constants, readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { Env } from "../config/env.ts";
import { deriveSubkeys, keyFingerprint, loadMasterKey, rotateKeyFile } from "../config/secret-key.ts";
import { createAppContext } from "../context.ts";
import { createDb } from "../db/index.ts";
import { MigrationError, migrateToLatest, readMigrationState } from "../db/migrate.ts";
import { serverJobs } from "../jobs/index.ts";
import { DAY_MS } from "../lib/clock.ts";
import { readServerStatus } from "../modules/maintenance/status.ts";
import type { ServerStatus } from "../modules/maintenance/status.ts";
import {
  ReleaseSignatureError,
  parseChecksums,
  verifyChecksums,
  verifyMinisign,
} from "../modules/maintenance/verify-release.ts";
import { CliError, EXIT_FAILURE, EXIT_OK, UsageError } from "./io.ts";
import type { CliOutput } from "./io.ts";
import { qrLines } from "./qr.ts";
import { withRuntime } from "./runtime.ts";
import type { OpenRuntimeOptions } from "./runtime.ts";

/** `migrate`: applies the pending migrations in one transaction (the host CLI runs it before `up -d`, DESIGN §7.5). */
export async function migrateCommand(env: Env, output: CliOutput, options: OpenRuntimeOptions): Promise<number> {
  const db = createDb(env, { log: options.log });
  try {
    const result = await migrateToLatest(db, { log: options.log });
    switch (result.status) {
      case "up_to_date":
        output.out(`database is up to date (${result.state.applied.length} migrations)\n`);
        return EXIT_OK;
      case "migrated":
        output.out(`applied: ${result.executed.join(", ")}\n`);
        return EXIT_OK;
      case "schema_newer":
        throw new CliError(
          `the database is newer than this image (unknown migrations: ${result.state.unknown.join(", ")}); ` +
            "run the newer image or restore a backup",
        );
    }
  } catch (error) {
    if (error instanceof MigrationError) throw new CliError(error.message);
    throw error;
  } finally {
    await db.destroy();
  }
}

function statusText(status: ServerStatus): string {
  const migrations = status.db.migrations;
  const lines = [
    `${status.software} ${status.version} (${status.revision})`,
    `server id:     ${status.serverId}`,
    `name:          ${status.instanceName}`,
    `address:       ${status.publicUrl ?? "(PUBLIC_URL not set)"}`,
    `registration:  ${status.registration}`,
    `database:      ${status.db.dialect}, ${migrations.applied} migrations` +
      (migrations.pending.length > 0 ? `, pending: ${migrations.pending.join(", ")}` : "") +
      (migrations.unknown.length > 0 ? `, NEWER than this image: ${migrations.unknown.join(", ")}` : ""),
    `restore:       ${status.restorePending ? "pending (the next start rotates every epoch)" : "none pending"}`,
    `accounts:      ${status.users.active} active, ${status.users.deleted} deleted (purge pending)`,
    `devices:       ${status.devices}`,
    `data:          ${status.dataDir}, secret key: ${status.secretKey}`,
  ];
  return `${lines.join("\n")}\n`;
}

/** `info [--json]`. */
export async function infoCommand(
  env: Env,
  output: CliOutput,
  options: OpenRuntimeOptions,
  json: boolean,
): Promise<number> {
  const status = await withRuntime(env, options, (runtime) =>
    readServerStatus({ env, db: runtime.db, serverId: runtime.serverId }),
  );
  output.out(json ? `${JSON.stringify(status)}\n` : statusText(status));
  return EXIT_OK;
}

/**
 * `check-config`: the environment parsed (the caller already did), the database reachable and its migrations, the
 * data directory writable, the master key; warnings for settings that are legal but usually wrong. Exit 1 on a
 * failed check.
 */
export async function checkConfigCommand(env: Env, output: CliOutput, options: OpenRuntimeOptions): Promise<number> {
  const failures: string[] = [];
  const ok = (text: string) => {
    output.out(`ok    ${text}\n`);
  };
  const warn = (text: string) => {
    output.out(`warn  ${text}\n`);
  };
  const fail = (text: string) => {
    failures.push(text);
    output.out(`FAIL  ${text}\n`);
  };

  ok("environment");
  const db = createDb(env, { log: options.log });
  try {
    const state = await readMigrationState(db);
    if (state.unknown.length > 0) fail(`database is newer than this image: ${state.unknown.join(", ")}`);
    else if (state.pending.length > 0) {
      const how = env.MIGRATE_ON_START ? "the server applies them at start" : 'run "melogold migrate"';
      warn(`database ${db.dialect}: ${state.pending.length} migrations pending (${how})`);
    } else ok(`database ${db.dialect}: ${state.applied.length} migrations applied`);
  } catch (error) {
    fail(`database ${db.dialect}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await db.destroy();
  }

  try {
    accessSync(env.DATA_DIR, constants.W_OK);
    ok(`data directory ${env.DATA_DIR} is writable`);
  } catch {
    fail(`data directory ${env.DATA_DIR} is not writable (a volume must be mounted there)`);
  }
  ok(`secret key: ${env.MELOGOLD_SECRET_KEY === null ? "file in the data directory" : "MELOGOLD_SECRET_KEY"}`);

  if (env.PUBLIC_URL === null) warn("PUBLIC_URL is not set: the QR code and the address shown to clients need it");
  else if (env.PUBLIC_URL.startsWith("http://") && env.REGISTRATION === "open") {
    warn("open registration over plain http: passwords travel unencrypted outside your network");
  }
  if (env.REGISTRATION === "open" && env.REGISTRATION_POW_BITS === 0) {
    warn("open registration without proof of work (REGISTRATION_POW_BITS=0) invites bots");
  }
  return failures.length > 0 ? EXIT_FAILURE : EXIT_OK;
}

/** `openapi [--yaml]`: the contract of this server version (the files shipped in the image). */
export function openapiCommand(output: CliOutput, yaml: boolean): number {
  const file = fileURLToPath(new URL(`../../openapi/openapi.${yaml ? "yaml" : "json"}`, import.meta.url));
  output.out(readFileSync(file, "utf8"));
  return EXIT_OK;
}

/** `qr [url] [--color|--plain]`: the address (default `PUBLIC_URL`) as a QR code, then the address itself. */
export function qrCommand(env: Env, output: CliOutput, url: string | undefined, color: boolean): number {
  const address = url ?? env.PUBLIC_URL;
  if (address === null)
    throw new UsageError("no address: pass one (melogold qr https://music.example.com) or set PUBLIC_URL");
  let parsed: URL;
  try {
    parsed = new URL(address);
  } catch {
    throw new UsageError(`not an address: ${address}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new UsageError(`the address must be http(s): ${address}`);
  }
  output.out(`${qrLines(address, { color }).join("\n")}\n\n${address}\n`);
  return EXIT_OK;
}

/**
 * `jobs run <name>`: one run of a background job (API §5) outside the server, at once. `sqlite-maintenance` runs its
 * daily heavy part. Ctrl-C stops the job between batches.
 */
export async function jobsRunCommand(
  env: Env,
  output: CliOutput,
  options: OpenRuntimeOptions,
  name: string,
): Promise<number> {
  return withRuntime(env, options, async (runtime) => {
    const master = loadMasterKey({
      dataDir: env.DATA_DIR,
      envKeyHex: env.MELOGOLD_SECRET_KEY,
      warn: (message) => {
        runtime.log.warn({}, message);
      },
    });
    const ctx = createAppContext({
      env,
      db: runtime.db,
      serverId: runtime.serverId,
      keys: deriveSubkeys(master.key, runtime.serverId),
      log: runtime.log,
      clock: runtime.clock,
    });
    const now = runtime.clock.now();
    const jobs = serverJobs(ctx, now - DAY_MS);
    const job = jobs.find((candidate) => candidate.name === name);
    if (job === undefined) {
      throw new UsageError(`unknown job "${name}"; jobs: ${jobs.map((candidate) => candidate.name).join(", ")}`);
    }
    const controller = new AbortController();
    const stop = () => {
      controller.abort();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      await job.run({
        name: job.name,
        signal: controller.signal,
        startedAt: now,
        log: { info: runtime.log.warn, warn: runtime.log.warn, error: runtime.log.error },
      });
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      await ctx.devices.idle();
    }
    output.out(controller.signal.aborted ? `${name}: stopped\n` : `${name}: done\n`);
    return EXIT_OK;
  });
}

/**
 * `secret rotate`: a new `<DATA_DIR>/secret.key` (DESIGN §4.13). Takes effect when the server restarts (the host CLI
 * does `up -d --force-recreate`): every device signs in again; data and recovery codes stay.
 */
export function secretRotateCommand(env: Env, output: CliOutput): number {
  if (env.MELOGOLD_SECRET_KEY !== null) {
    throw new CliError("MELOGOLD_SECRET_KEY is set and wins over the file: change that variable instead");
  }
  rotateKeyFile(env.DATA_DIR);
  const master = loadMasterKey({ dataDir: env.DATA_DIR, envKeyHex: null, warn: () => undefined });
  output.out(
    `new secret key ${keyFingerprint(master.key)} written to ${master.file}\n` +
      "restart the server to use it: every device will have to sign in again\n",
  );
  return EXIT_OK;
}

/**
 * `verify-release <SHA256SUMS> <SHA256SUMS.minisig> [file…]`: the release signature against the key compiled into this
 * image (DESIGN §7.5 step 2, m25), then each named file against its `SHA256SUMS` line.
 */
export function verifyReleaseCommand(
  output: CliOutput,
  input: Readonly<{ sums: string; signature: string; files: readonly string[]; publicKey: string | null }>,
): number {
  if (input.publicKey === null) {
    throw new CliError("this image carries no release key, so it cannot check release signatures");
  }
  try {
    const sums = readFileSync(input.sums);
    const comment = verifyMinisign(input.publicKey, readFileSync(input.signature, "utf8"), sums);
    output.out(`signature ok: ${comment}\n`);
    verifyChecksums(
      parseChecksums(sums.toString("utf8")),
      input.files.map((file) => ({ name: basename(file), bytes: readFileSync(file) })),
    );
    for (const file of input.files) output.out(`ok ${basename(file)}\n`);
    return EXIT_OK;
  } catch (error) {
    if (error instanceof ReleaseSignatureError) throw new CliError(error.message);
    if (error instanceof Error && "code" in error && error.code === "ENOENT") throw new CliError(error.message);
    throw error;
  }
}
