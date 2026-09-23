/**
 * `melogold serve` (DESIGN §6.3, §7): the server process.
 *
 * {@link startServer}, in this order, **before** anything listens:
 * 1. the logger (Fastify's pino with masking) and a warning when `/data` is not a mounted volume (DESIGN §7.1);
 * 2. the master key (`MELOGOLD_SECRET_KEY` or `<DATA_DIR>/secret.key`, created if missing);
 * 3. the database: pending migrations (`MIGRATE_ON_START`), then the schema check (`SCHEMA_CHECK`);
 * 4. `server_meta.server_id`, then the restore flag: with `restore_pending = '1'` every user's epoch is rotated
 *    and the flag cleared (DESIGN §3.15, API §5 "Restore");
 * 5. the subkeys (HKDF with the server id), the context, the routes, the first disk measurement;
 * 6. listen, then the background jobs.
 *
 * {@link RunningServer.shutdown} drains: new requests answer `503 unavailable` (`/health` too), `app.close()` waits for
 * the requests in flight and closes the SSE streams, the jobs stop, pending `last_sync_at` writes finish, the database
 * closes. {@link runServer} wires it to SIGINT/SIGTERM and fatal errors with `close-with-grace`: past
 * `SHUTDOWN_GRACE_MS` the process exits with code 1. A startup failure (bad environment, key, migrations, schema)
 * exits with code 1.
 */
import { existsSync, readFileSync } from "node:fs";
import closeWithGrace from "close-with-grace";
import type { FastifyInstance } from "fastify";
import { buildApp, createFastify } from "./app.ts";
import { EnvError, loadEnv } from "./config/env.ts";
import type { Env } from "./config/env.ts";
import { deriveSubkeys, loadMasterKey } from "./config/secret-key.ts";
import { createAppContext } from "./context.ts";
import type { AppContext, AppLogger } from "./context.ts";
import { createDb } from "./db/index.ts";
import type { Db } from "./db/index.ts";
import { prepareDatabase } from "./db/migrate.ts";
import { registerJobs } from "./jobs/index.ts";
import { Scheduler } from "./jobs/scheduler.ts";
import { systemClock } from "./lib/clock.ts";
import type { Clock } from "./lib/clock.ts";
import { applyPendingRestore, initServerIdentity } from "./modules/server/server.service.ts";

/** The volume of the image (DESIGN §7.1). */
export const IMAGE_DATA_DIR = "/data";

export type RunningServer = Readonly<{
  app: FastifyInstance;
  ctx: AppContext;
  scheduler: Scheduler;
  /** `http://host:port` the server listens on. */
  address: string;
  /** Drains and stops everything; idempotent. */
  shutdown(): Promise<void>;
}>;

export type StartServerOptions = Readonly<{
  env: Env;
  clock?: Clock;
  /** Tests: read `/proc/self/mountinfo` from elsewhere (`null`: not Linux). */
  mountinfo?: () => string | null;
}>;

/** Unescapes the octal escapes of `/proc/self/mountinfo` (`\040` is a space). */
function unescapeMountPath(path: string): string {
  return path.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

/** Whether `path` is a mount point in the text of `/proc/self/mountinfo` (field 5 of each line). */
export function isMountPoint(mountinfo: string, path: string): boolean {
  const wanted = path.replace(/\/+$/, "") || "/";
  return mountinfo.split("\n").some((line) => {
    const field = line.split(" ")[4];
    return field !== undefined && unescapeMountPath(field) === wanted;
  });
}

function readMountinfo(): string | null {
  try {
    return existsSync("/proc/self/mountinfo") ? readFileSync("/proc/self/mountinfo", "utf8") : null;
  } catch {
    return null;
  }
}

/** DESIGN §7.1: the image declares no `VOLUME`; data in an unmounted `/data` dies with the container. */
export function warnIfDataNotMounted(
  env: Pick<Env, "DATA_DIR">,
  log: Pick<AppLogger, "warn">,
  mountinfo: string | null,
): void {
  if (env.DATA_DIR !== IMAGE_DATA_DIR || mountinfo === null) return;
  if (isMountPoint(mountinfo, IMAGE_DATA_DIR)) return;
  log.warn(
    { dataDir: IMAGE_DATA_DIR },
    "/data is NOT a mounted volume: the database and secret.key will be lost with the container. " +
      "Run with -v melogold-data:/data (see docs/self-hosting.md).",
  );
}

/** Starts the server (steps 1–6 above). On failure everything opened so far is closed and the error is rethrown. */
export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const { env } = options;
  const clock = options.clock ?? systemClock;
  const app = createFastify(env);
  const log: AppLogger = app.log;
  let db: Db | null = null;
  try {
    warnIfDataNotMounted(env, log, (options.mountinfo ?? readMountinfo)());

    const master = loadMasterKey({
      dataDir: env.DATA_DIR,
      envKeyHex: env.MELOGOLD_SECRET_KEY,
      warn: (message) => {
        log.warn({}, message);
      },
    });
    if (master.createdFile) log.info({ file: master.file }, "created a new secret key");

    const opened = createDb(env, { log, now: () => clock.now() });
    db = opened;
    const prepared = await prepareDatabase(opened, {
      log,
      migrateOnStart: env.MIGRATE_ON_START,
      schemaCheck: env.SCHEMA_CHECK,
    });
    if (prepared.migration.status === "migrated") {
      log.info({ migrations: prepared.migration.executed }, "database migrated");
    }

    const serverId = await initServerIdentity(opened, clock.now());
    await applyPendingRestore(opened, { now: clock.now(), graceDays: env.RESTORE_REFRESH_GRACE_DAYS, log });

    const ctx = createAppContext({ env, db: opened, serverId, keys: deriveSubkeys(master.key, serverId), log, clock });
    await buildApp(ctx, { app });
    const scheduler = new Scheduler({ clock, log, random: ctx.random });
    registerJobs(scheduler, ctx);
    await ctx.diskGuard.check();

    const address = await app.listen({ host: env.HOST, port: env.PORT });
    scheduler.start();
    log.info(
      { address, version: env.APP_VERSION, revision: env.GIT_SHA, db: opened.dialect, serverId },
      "melogold server is listening",
    );

    let stopping: Promise<void> | null = null;
    const shutdown = (): Promise<void> => {
      stopping ??= (async () => {
        ctx.lifecycle.startDraining();
        log.info({}, "shutting down: draining requests");
        await app.close();
        await scheduler.stop();
        await ctx.devices.idle();
        await opened.destroy();
        log.info({}, "stopped");
      })();
      return stopping;
    };
    return Object.freeze({ app, ctx, scheduler, address, shutdown });
  } catch (error) {
    await app.close().catch(() => undefined);
    await db?.destroy().catch(() => undefined);
    throw error;
  }
}

function exitCodeOf(error: unknown): number {
  const code = (error as { exitCode?: unknown } | null)?.exitCode;
  return typeof code === "number" && Number.isInteger(code) && code > 0 ? code : 1;
}

/**
 * `melogold serve`: reads the environment, starts, and shuts down gracefully on SIGINT/SIGTERM or a fatal error.
 * Sets `process.exitCode` on a startup failure.
 */
export async function runServer(_argv: readonly string[] = []): Promise<void> {
  let env: Env;
  try {
    env = loadEnv();
  } catch (error) {
    process.stderr.write(`${error instanceof EnvError ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }
  let running: RunningServer;
  try {
    running = await startServer({ env });
  } catch (error) {
    process.stderr.write(`melogold: startup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    const cause = error instanceof Error ? error.cause : undefined;
    if (cause instanceof Error) process.stderr.write(`  cause: ${cause.message}\n`);
    process.exitCode = exitCodeOf(error);
    return;
  }
  const log = running.ctx.log;
  closeWithGrace(
    {
      delay: env.SHUTDOWN_GRACE_MS,
      logger: {
        error: (message: unknown) => {
          log.error({ detail: message }, "shutdown");
        },
      },
    },
    async ({ signal, err }) => {
      if (err) log.fatal({ err }, "fatal error: shutting down");
      else log.info({ signal: signal ?? null }, "signal received");
      await running.shutdown();
    },
  );
}
