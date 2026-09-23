/**
 * Test data without HTTP (PLAN M0 step 0.9): a user (with its `sync_heads` row, as registration creates it), a
 * device, and a session (refresh token row + access token) issued exactly like the services do, through
 * `issueSession` inside `db.write`.
 *
 * ```ts
 * const account = await createAccount(ctx);                       // user + device + session
 * await app.inject({ method: "GET", url: "/auth/me", headers: bearer(account.session.tokens.accessToken) });
 * const second = await createDevice(ctx.db, account.user.id, { name: "MacBook Air", linkedVia: "link" });
 * ```
 *
 * Every helper takes plain values, so tests can build any state (a deleted user, an old device, a stale
 * `auth_version`) and then observe the API.
 */
import { randomBytes } from "node:crypto";
import type { Env } from "../config/env.ts";
import type { Subkeys } from "../config/secret-key.ts";
import type { Db } from "../db/index.ts";
import { insertHead } from "../db/heads.ts";
import { sha256Hex } from "../lib/crypto.ts";
import { newId } from "../lib/ids.ts";
import { issueSession, sessionConfig } from "../lib/session.ts";
import type { IssuedSession } from "../lib/session.ts";

/** A PHC string that parses as argon2id but never verifies: tests that log in pass a real hash. */
export const UNUSABLE_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,t=3,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/** The recovery code of every factory user (API §1.6 form) and its stored hash (API §8). */
export const TEST_RECOVERY_CODE = "7KQ2-MX9D-4TNP-B8RW-3HZF";
export function recoveryCodeHash(code: string): string {
  return sha256Hex(`melogold-recovery-v1:${code.replaceAll("-", "")}`);
}

export type TestUser = Readonly<{
  id: string;
  login: string;
  authVersion: number;
  createdAt: number;
  /** `sync_heads.epoch`. */
  epoch: string;
}>;

export type CreateUserOptions = Readonly<{
  id?: string;
  login?: string;
  now?: number;
  passwordHash?: string;
  authVersion?: number;
  deletedAt?: number | null;
  recoveryCode?: string;
  recoveryCodeConfirmedAt?: number | null;
  createdBy?: "self" | "admin";
  /** Also set `server_meta.first_user_id` (registration mode `first`). */
  firstUser?: boolean;
  /** Skip the `sync_heads` row (to test `ensureHead`). */
  withoutHead?: boolean;
}>;

let sequence = 0;

/** A unique valid login (`^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$`). */
export function uniqueLogin(prefix = "user"): string {
  sequence += 1;
  return `${prefix}${sequence}${randomBytes(3).toString("hex")}`;
}

export async function createUser(db: Pick<Db, "write">, options: CreateUserOptions = {}): Promise<TestUser> {
  const id = options.id ?? newId();
  const login = options.login ?? uniqueLogin();
  const now = options.now ?? Date.now();
  const authVersion = options.authVersion ?? 1;
  const epoch = await db.write(async (q) => {
    await q
      .insertInto("users")
      .values({
        id,
        login,
        password_hash: options.passwordHash ?? UNUSABLE_PASSWORD_HASH,
        auth_version: authVersion,
        password_changed_at: now,
        recovery_code_hash: recoveryCodeHash(options.recoveryCode ?? TEST_RECOVERY_CODE),
        recovery_code_created_at: now,
        recovery_code_confirmed_at: options.recoveryCodeConfirmedAt ?? null,
        created_by: options.createdBy ?? "self",
        deleted_at: options.deletedAt ?? null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    if (options.firstUser === true) {
      await q
        .insertInto("server_meta")
        .values({ key: "first_user_id", value: id })
        .onConflict((conflict) => conflict.column("key").doNothing())
        .execute();
    }
    if (options.withoutHead === true) return "";
    return (await insertHead(q, id, now)).epoch;
  });
  return Object.freeze({ id, login, authVersion, createdAt: now, epoch });
}

export type TestDevice = Readonly<{
  id: string;
  userId: string;
  /** The client-side hwid (64 hex); the database keeps `sha256(hwid)`. */
  hwid: string;
  name: string;
  platform: string;
  linkedVia: string;
  createdAt: number;
}>;

export type CreateDeviceOptions = Readonly<{
  id?: string;
  hwid?: string;
  name?: string;
  customName?: string | null;
  platform?: string;
  osVersion?: string | null;
  model?: string | null;
  clientVersion?: string | null;
  linkedVia?: "register" | "login" | "link" | "recovery";
  linkedByDeviceId?: string | null;
  now?: number;
  lastSeenAt?: number;
  lastSyncAt?: number | null;
}>;

export async function createDevice(
  db: Pick<Db, "write">,
  userId: string,
  options: CreateDeviceOptions = {},
): Promise<TestDevice> {
  const id = options.id ?? newId();
  const hwid = options.hwid ?? randomBytes(32).toString("hex");
  const now = options.now ?? Date.now();
  const device = {
    id,
    userId,
    hwid,
    name: options.name ?? "Google Pixel 8",
    platform: options.platform ?? "android",
    linkedVia: options.linkedVia ?? "register",
    createdAt: now,
  };
  await db.write((q) =>
    q
      .insertInto("devices")
      .values({
        id,
        user_id: userId,
        hwid_hash: sha256Hex(hwid),
        reported_name: device.name,
        custom_name: options.customName ?? null,
        platform: device.platform,
        os_version: options.osVersion ?? null,
        model: options.model ?? null,
        client_version: options.clientVersion ?? null,
        linked_via: device.linkedVia,
        linked_by_device_id: options.linkedByDeviceId ?? null,
        created_at: now,
        last_seen_at: options.lastSeenAt ?? now,
        last_sync_at: options.lastSyncAt ?? null,
      })
      .execute(),
  );
  return Object.freeze(device);
}

export type SessionContext = Readonly<{
  db: Pick<Db, "write">;
  env: Pick<Env, "ACCESS_TOKEN_TTL_SECONDS" | "REFRESH_TOKEN_TTL_DAYS">;
  keys: Pick<Subkeys, "jwtAccess" | "refreshToken">;
  clock: Readonly<{ now(): number }>;
}>;

/** A refresh token row and a token pair for the device, as `issueSession` makes them. */
export function createSession(
  ctx: SessionContext,
  input: Readonly<{ userId: string; deviceId: string; authVersion?: number; now?: number }>,
): Promise<IssuedSession> {
  const now = input.now ?? ctx.clock.now();
  return ctx.db.write((q) =>
    issueSession(
      q,
      { userId: input.userId, deviceId: input.deviceId, authVersion: input.authVersion ?? 1, now },
      sessionConfig(ctx.env, ctx.keys),
    ),
  );
}

export type TestAccount = Readonly<{ user: TestUser; device: TestDevice; session: IssuedSession }>;

/** A user with one device and a session, at the context's current time. */
export async function createAccount(
  ctx: SessionContext,
  options: Readonly<{ user?: CreateUserOptions; device?: CreateDeviceOptions }> = {},
): Promise<TestAccount> {
  const now = ctx.clock.now();
  const user = await createUser(ctx.db, { now, ...options.user });
  const device = await createDevice(ctx.db, user.id, { now, ...options.device });
  const session = await createSession(ctx, {
    userId: user.id,
    deviceId: device.id,
    authVersion: user.authVersion,
    now,
  });
  return Object.freeze({ user, device, session });
}

/** `Authorization: Bearer <token>` for `app.inject`. */
export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}
