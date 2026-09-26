/**
 * The state of the server for `melogold info` (DESIGN §7.4, PLAN T3.1): versions, identity, database and migrations,
 * the restore flag, how many accounts and devices there are, where the master key comes from. Read-only.
 */
import { existsSync } from "node:fs";
import type { Env } from "../../config/env.ts";
import { secretKeyPath } from "../../config/secret-key.ts";
import type { Db } from "../../db/index.ts";
import { readMigrationState } from "../../db/migrate.ts";
import { SOFTWARE_NAME } from "../../contract/server.ts";
import { isRestorePending } from "../server/server.service.ts";
import { countDevices, countUsers } from "./maintenance.repository.ts";

export type ServerStatus = Readonly<{
  software: string;
  version: string;
  revision: string;
  serverId: string;
  instanceName: string;
  publicUrl: string | null;
  registration: string;
  db: Readonly<{
    dialect: string;
    migrations: Readonly<{ applied: number; pending: readonly string[]; unknown: readonly string[] }>;
  }>;
  restorePending: boolean;
  users: Readonly<{ active: number; deleted: number }>;
  devices: number;
  dataDir: string;
  /** `env` (`MELOGOLD_SECRET_KEY`), `file` (`<DATA_DIR>/secret.key`) or `missing` (the next start creates it). */
  secretKey: "env" | "file" | "missing";
}>;

export async function readServerStatus(input: Readonly<{ env: Env; db: Db; serverId: string }>): Promise<ServerStatus> {
  const { env, db } = input;
  const migrations = await readMigrationState(db);
  const users = await db.run((q) => countUsers(q));
  const devices = await db.run((q) => countDevices(q));
  const secretKey =
    env.MELOGOLD_SECRET_KEY !== null ? "env" : existsSync(secretKeyPath(env.DATA_DIR)) ? "file" : "missing";
  return Object.freeze({
    software: SOFTWARE_NAME,
    version: env.APP_VERSION,
    revision: env.GIT_SHA,
    serverId: input.serverId,
    instanceName: env.INSTANCE_NAME,
    publicUrl: env.PUBLIC_URL,
    registration: env.REGISTRATION,
    db: Object.freeze({
      dialect: db.dialect,
      migrations: Object.freeze({
        applied: migrations.applied.length,
        pending: migrations.pending,
        unknown: migrations.unknown,
      }),
    }),
    restorePending: await isRestorePending(db),
    users,
    devices,
    dataDir: env.DATA_DIR,
    secretKey,
  });
}
