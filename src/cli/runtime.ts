/**
 * What the CLI commands that touch the database open (DESIGN §7.4, PLAN T3.1), in the order of the server start
 * (`server.ts`) but without Fastify:
 *
 * 1. the database of `DATABASE_URL`;
 * 2. pending migrations (unless `MIGRATE_ON_START=false`: then pending migrations are an error, as for the server)
 *    and the schema check, so `docker run … user add` works on a fresh volume before the server ever started;
 * 3. `server_meta.server_id`.
 *
 * The restore flag is **not** applied here: the next server start or `melogold restore` applies it.
 */
import type { Env } from "../config/env.ts";
import type { AppLogger } from "../context.ts";
import { createDb } from "../db/index.ts";
import type { Db } from "../db/index.ts";
import { prepareDatabase } from "../db/migrate.ts";
import { systemClock } from "../lib/clock.ts";
import type { Clock } from "../lib/clock.ts";
import { initServerIdentity } from "../modules/server/server.service.ts";

export type CliRuntime = Readonly<{
  env: Env;
  db: Db;
  clock: Clock;
  log: AppLogger;
  serverId: string;
  close(): Promise<void>;
}>;

export type OpenRuntimeOptions = Readonly<{
  log: AppLogger;
  clock?: Clock;
  /** `false`: only open the database (no migrations, no schema check, no server id); for read-only diagnostics. */
  prepare?: boolean;
}>;

/** Opens the database (steps 1–3 above); on failure everything opened is closed and the error rethrown. */
export async function openRuntime(env: Env, options: OpenRuntimeOptions): Promise<CliRuntime> {
  const clock = options.clock ?? systemClock;
  const { log } = options;
  const db = createDb(env, { log, now: () => clock.now() });
  try {
    let serverId = "";
    if (options.prepare !== false) {
      const prepared = await prepareDatabase(db, {
        log,
        migrateOnStart: env.MIGRATE_ON_START,
        schemaCheck: env.SCHEMA_CHECK,
      });
      if (prepared.migration.status === "migrated") {
        log.info({ migrations: prepared.migration.executed }, "database migrated");
      }
      serverId = await initServerIdentity(db, clock.now());
    }
    return Object.freeze({
      env,
      db,
      clock,
      log,
      serverId,
      close: () => db.destroy(),
    });
  } catch (error) {
    await db.destroy();
    throw error;
  }
}

/** Runs `body` with an open runtime and always closes it. */
export async function withRuntime<T>(
  env: Env,
  options: OpenRuntimeOptions,
  body: (runtime: CliRuntime) => Promise<T>,
): Promise<T> {
  const runtime = await openRuntime(env, options);
  try {
    return await body(runtime);
  } finally {
    await runtime.close();
  }
}
