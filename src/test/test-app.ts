/**
 * The whole application over a test database (DESIGN §10: `app.inject`, both dialects): `createTestApp()` migrates a
 * fresh database of `TEST_DB`, creates `server_meta.server_id`, builds `ctx` with a manual clock, fixed subkeys and a
 * silent logger, and builds the app with every module (M0: stubs).
 *
 * ```ts
 * const t = await createTestApp();
 * after(() => t.close());
 * const account = await createAccount(t.ctx);
 * const response = await t.app.inject({ method: "GET", url: "/auth/me", headers: bearer(account.session.tokens.accessToken) });
 * ```
 *
 * Defaults: `RATE_LIMIT_ENABLED=false` (tests of limits turn it on), `LOG_LEVEL=silent`, a disk that is never full
 * (`t.disk.full = true` makes it full), `Math.random` replaced by `() => 0`.
 */
import assert from "node:assert/strict";
import type { FastifyInstance, LightMyRequestResponse, RouteOptions } from "fastify";
import { buildApp, createFastify } from "../app.ts";
import { deriveSubkeys } from "../config/secret-key.ts";
import type { Subkeys } from "../config/secret-key.ts";
import { createAppContext } from "../context.ts";
import type { AppContext, AppLogger } from "../context.ts";
import type { Db } from "../db/index.ts";
import { storageFullError } from "../http/disk-guard.ts";
import type { DiskGuard, DiskStatus } from "../http/disk-guard.ts";
import { isErrorCode } from "../http/error-codes.ts";
import { ManualClock } from "../lib/clock.ts";
import { LruSet } from "../lib/lru.ts";
import { initServerIdentity } from "../modules/server/server.service.ts";
import { createMigratedTestDatabase } from "./test-db.ts";
import type { TestDatabase } from "./test-db.ts";

/** 2026-09-23T10:00:00.000Z, the time of the examples in API.md. */
export const TEST_T0 = Date.UTC(2026, 8, 23, 10, 0, 0);
/** Master key of every test app (never used outside tests). */
export const TEST_MASTER_KEY = Buffer.alloc(32, 7);

export type TestDisk = { full: boolean };

export type TestApp = Readonly<{
  app: FastifyInstance;
  ctx: AppContext;
  db: Db;
  database: TestDatabase;
  clock: ManualClock;
  keys: Subkeys;
  disk: TestDisk;
  /** The guard's confirmed-`rid` cache. */
  confirmedRefreshIds: LruSet<string>;
  /** Closes the app, the database and removes it. */
  close(): Promise<void>;
}>;

export type CreateTestAppOptions = Readonly<{
  /** Extra environment variables (`REGISTRATION`, `CORS_ORIGINS`, `RATE_LIMIT_ENABLED`, …). */
  env?: Readonly<Record<string, string>>;
  now?: number;
  log?: AppLogger;
  /** Called before `ready()`, e.g. to declare features or add a test-only route. */
  configure?: (t: Readonly<{ app: FastifyInstance; ctx: AppContext }>) => void | Promise<void>;
  /** Sees every route as it is added (route inventory tests). */
  onRoute?: (route: RouteOptions) => void;
}>;

function testDiskGuard(disk: TestDisk, now: () => number): DiskGuard {
  const status = (): DiskStatus => ({ freePercent: disk.full ? 1 : 50, full: disk.full, checkedAt: now() });
  return Object.freeze({
    check: () => Promise.resolve(status()),
    status,
    isFull: () => disk.full,
    assertWritable: () => {
      if (disk.full) throw storageFullError();
    },
    start: () => undefined,
    stop: () => undefined,
  });
}

export async function createTestApp(options: CreateTestAppOptions = {}): Promise<TestApp> {
  const { database, db } = await createMigratedTestDatabase({
    env: { LOG_LEVEL: "silent", RATE_LIMIT_ENABLED: "false", ...options.env },
  });
  try {
    const clock = new ManualClock(options.now ?? TEST_T0);
    const serverId = await initServerIdentity(db, clock.now());
    const keys = deriveSubkeys(TEST_MASTER_KEY, serverId);
    const disk: TestDisk = { full: false };
    const ctx = createAppContext({
      env: database.env,
      db,
      serverId,
      keys,
      clock,
      random: () => 0,
      diskGuard: testDiskGuard(disk, () => clock.now()),
      ...(options.log ? { log: options.log } : {}),
    });
    const confirmedRefreshIds = new LruSet<string>(1000);
    const instance = createFastify(database.env);
    const { onRoute } = options;
    if (onRoute) {
      instance.addHook("onRoute", (route) => {
        onRoute(route);
      });
    }
    const app = await buildApp(ctx, { app: instance, confirmedRefreshIds });
    await options.configure?.({ app, ctx });
    await app.ready();
    let closed = false;
    return Object.freeze({
      app,
      ctx,
      db,
      database,
      clock,
      keys,
      disk,
      confirmedRefreshIds,
      close: async () => {
        if (closed) return;
        closed = true;
        await app.close();
        await ctx.devices.idle();
        await db.destroy();
        await database.cleanup();
      },
    });
  } catch (error) {
    await db.destroy();
    await database.cleanup();
    throw error;
  }
}

/** The JSON body of a response. */
export function json(response: LightMyRequestResponse): Record<string, unknown> {
  return response.json<Record<string, unknown>>();
}

/** API §2.1: the four keys of the envelope (then details only), a registered code, the expected status. */
export function assertError(response: LightMyRequestResponse, status: number, code: string): Record<string, unknown> {
  assert.equal(response.statusCode, status, `expected ${status} ${code}, got ${response.statusCode}: ${response.body}`);
  assert.match(String(response.headers["content-type"]), /^application\/json/);
  const body = json(response);
  assert.equal(body.code, code, response.body);
  assert.ok(isErrorCode(body.code), `unregistered code in ${response.body}`);
  assert.equal(body.statusCode, status);
  assert.equal(typeof body.message, "string");
  assert.equal(body.error, body.message);
  assert.deepEqual(Object.keys(body).slice(0, 4), ["statusCode", "error", "message", "code"]);
  return body;
}
