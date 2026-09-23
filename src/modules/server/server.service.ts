/**
 * The `server` module (API §4.2, DESIGN §3.15): server identity, readiness, discovery and the restore flag.
 *
 * - {@link initServerIdentity}: `server_meta.server_id` (a UUID made once, the HKDF salt of every subkey) and
 *   `created_at`, created on the first start.
 * - {@link applyPendingRestore}: when `server_meta.restore_pending = '1'` (every backup carries it), the start gives
 *   every user a new random cursor epoch in batches, opens the refresh grace window
 *   (`restore_refresh_grace_until = now + RESTORE_REFRESH_GRACE_DAYS`) and clears the flag, **before** the API
 *   listens. A crash in between leaves the flag set, so the next start repeats the rotation.
 * - {@link checkReadiness}: `GET /health` = `SELECT 1` within 2 s; `503 unavailable` while draining or without the
 *   database.
 * - {@link buildServerInfo}: `GET /server/info`.
 */
import type { AppContext, AppLogger } from "../../context.ts";
import type { HealthResponse, ServerInfo } from "../../contract/server.ts";
import { SOFTWARE_NAME } from "../../contract/server.ts";
import { buildServerLimits } from "../../contract/limits.ts";
import type { Db } from "../../db/index.ts";
import { newEpoch } from "../../db/heads.ts";
import { AppError } from "../../http/errors.ts";
import { DAY_MS } from "../../lib/clock.ts";
import { isUuid, newId } from "../../lib/ids.ts";
import { API_VERSION, MIN_API_VERSION } from "../../lib/protocol.ts";
import { formatIso } from "../../lib/time.ts";
import {
  deleteMeta,
  headUserIdsAfter,
  insertMetaIfAbsent,
  META_CREATED_AT,
  META_FIRST_USER_ID,
  META_RESTORE_PENDING,
  META_RESTORE_REFRESH_GRACE_UNTIL,
  META_SERVER_ID,
  ping,
  readMeta,
  setHeadEpoch,
  upsertMeta,
} from "./server.repository.ts";

/** `GET /health`: `SELECT 1` must answer within this time (API §3). */
export const HEALTH_TIMEOUT_MS = 2000;
/** `Retry-After` of `/health` answering `503 unavailable` (API §2.4: unavailable → 5 s). */
export const HEALTH_RETRY_AFTER_SECONDS = 5;
/** Users per write transaction of the epoch rotation (DESIGN §3.15 "пачками"). */
export const EPOCH_ROTATION_BATCH = 500;

/**
 * Makes sure `server_meta` has `server_id` and `created_at` and returns the server id.
 * @throws Error when the stored id is not a lowercase UUID (a damaged database).
 */
export async function initServerIdentity(db: Pick<Db, "write">, now: number): Promise<string> {
  const serverId = await db.write(async (q) => {
    const id = await insertMetaIfAbsent(q, META_SERVER_ID, newId());
    await insertMetaIfAbsent(q, META_CREATED_AT, String(now));
    return id;
  });
  if (!isUuid(serverId)) throw new Error("server_meta.server_id is not a lowercase UUID");
  return serverId;
}

export type RestoreOutcome = Readonly<{ rotatedUsers: number; graceUntil: number }>;

export type ApplyPendingRestoreOptions = Readonly<{
  now: number;
  /** `RESTORE_REFRESH_GRACE_DAYS`. */
  graceDays: number;
  log: Pick<AppLogger, "warn">;
  batchSize?: number;
  epoch?: () => string;
}>;

/**
 * DESIGN §3.15 step 2: rotates every user's epoch when the database was restored from a backup.
 * @returns what was done, or `null` when no restore is pending.
 */
export async function applyPendingRestore(
  db: Pick<Db, "read" | "write">,
  options: ApplyPendingRestoreOptions,
): Promise<RestoreOutcome | null> {
  const pending = await db.read((q) => readMeta(q, META_RESTORE_PENDING));
  if (pending !== "1") return null;
  const batchSize = options.batchSize ?? EPOCH_ROTATION_BATCH;
  const epoch = options.epoch ?? newEpoch;
  let after: string | null = null;
  let rotatedUsers = 0;
  for (;;) {
    const from: string | null = after;
    const ids: string[] = await db.write(async (q) => {
      const page = await headUserIdsAfter(q, from, batchSize);
      for (const userId of page) await setHeadEpoch(q, userId, epoch(), options.now);
      return page;
    });
    rotatedUsers += ids.length;
    if (ids.length < batchSize) break;
    after = ids[ids.length - 1] ?? null;
  }
  const graceUntil = options.now + options.graceDays * DAY_MS;
  await db.write(async (q) => {
    await upsertMeta(q, META_RESTORE_REFRESH_GRACE_UNTIL, String(graceUntil));
    await deleteMeta(q, META_RESTORE_PENDING);
  });
  options.log.warn(
    { rotatedUsers, restoreRefreshGraceUntil: formatIso(graceUntil) },
    "the database was restored from a backup: every cursor epoch was rotated, devices will merge silently",
  );
  return Object.freeze({ rotatedUsers, graceUntil });
}

function unavailable(): AppError<"unavailable"> {
  return new AppError("unavailable", { details: { retryAfterSeconds: HEALTH_RETRY_AFTER_SECONDS } });
}

/** Resolves or rejects like `promise`, or rejects after `ms`; a late rejection of `promise` is swallowed. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out after ${ms} ms`));
    }, ms);
    timer.unref();
  });
  promise.catch(() => undefined);
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * `GET /health` (API §4.2).
 * @throws AppError `503 unavailable` while draining, or when `SELECT 1` fails or takes longer than 2 s.
 */
export async function checkReadiness(
  ctx: Pick<AppContext, "db" | "env" | "lifecycle" | "log">,
  timeoutMs: number = HEALTH_TIMEOUT_MS,
): Promise<HealthResponse> {
  if (ctx.lifecycle.isDraining()) throw unavailable();
  try {
    await withTimeout(
      ctx.db.run((q) => ping(q)),
      timeoutMs,
    );
  } catch (error) {
    ctx.log.warn({ err: error }, "readiness check failed: the database does not answer");
    throw unavailable();
  }
  return { status: "ok", version: ctx.env.APP_VERSION, db: ctx.db.dialect };
}

/** `ServerInfo.registration`: `first` is `open` until the first user exists (API §4.2, DESIGN §4.2). */
export async function registrationState(ctx: Pick<AppContext, "db" | "env">): Promise<"open" | "closed"> {
  switch (ctx.env.REGISTRATION) {
    case "open":
      return "open";
    case "closed":
      return "closed";
    case "first": {
      const firstUser = await ctx.db.run((q) => readMeta(q, META_FIRST_USER_ID));
      return firstUser === null ? "open" : "closed";
    }
  }
}

/** `ServerInfo.revision`: the short git sha (7), or `unknown` outside an image build. */
export function shortRevision(gitSha: string): string {
  return /^[0-9a-f]{7,40}$/i.test(gitSha) ? gitSha.slice(0, 7).toLowerCase() : gitSha;
}

/** `GET /server/info` (API §4.2). */
export async function buildServerInfo(
  ctx: Pick<AppContext, "db" | "env" | "clock" | "serverId" | "features">,
  secureTransport: boolean,
): Promise<ServerInfo> {
  const { env } = ctx;
  return {
    software: SOFTWARE_NAME,
    version: env.APP_VERSION,
    revision: shortRevision(env.GIT_SHA),
    apiVersion: API_VERSION,
    minApiVersion: MIN_API_VERSION,
    serverId: ctx.serverId,
    instanceName: env.INSTANCE_NAME,
    publicUrl: env.PUBLIC_URL,
    secureTransport,
    registration: await registrationState(ctx),
    features: ctx.features.snapshot(),
    limits: buildServerLimits(env),
    links: { source: env.SOURCE_URL, privacy: env.PRIVACY_URL, contact: env.CONTACT },
    serverTime: formatIso(ctx.clock.now()),
  };
}
