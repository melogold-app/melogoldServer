/**
 * Registration, login and the profile (API §4.3, DESIGN §4.1–4.2, §4.6). Refresh and logout live in
 * `refresh.service.ts`.
 *
 * **Register** (`POST /auth/register`), in the order of DESIGN §4.2:
 * 1. registration mode ({@link AuthService.registrationGate}, before the schema): `closed` → `403 registration_closed`;
 *    `first` → closed as soon as `server_meta.first_user_id` exists;
 * 2. proof of work (same gate, `pow.ts`);
 * 3. the schema (Fastify), then the login format → `400 invalid_login_format`;
 * 4. reserved or taken → `409 login_taken`;
 * 5. the password policy → `400 password_*`;
 * 6. argon2 outside any transaction;
 * 7. one transaction: `first_user_id` (`ON CONFLICT DO NOTHING RETURNING`: no row in mode `first` →
 *    `403 registration_closed`) → `users` (`ON CONFLICT (login) DO NOTHING RETURNING`: no row → `409 login_taken`) →
 *    `devices(linked_via='register')` → `refresh_tokens` (`issueSession`) → `sync_heads`.
 *
 * **Login** (`POST /auth/login`, DESIGN §4.1, §4.6):
 * 1. one read: the account by normalized login, the throttle lock of that login, whether `sha256(hwid)` is a device
 *    of the account;
 * 2. locked and not a known device → `429 login_throttled`, without argon2;
 * 3. argon2: the account's hash, or a dummy hash of the same cost for an unknown login;
 * 4. wrong → the failure is counted (unknown logins too) → `401 invalid_credentials`, or `429 login_throttled` when
 *    this failure locked the login (5 failures are free);
 * 5. right → a rehash if the parameters changed (argon2 again, still outside the transaction), then one transaction
 *    under `lockUser`: the account must still have the verified hash; a known `(user, hwid)` reuses its row and gets
 *    a new token family; a new device is created with `linked_via='login'` after the device limit
 *    (`409 device_limit_reached`); the throttle row is deleted;
 * 6. after commit: `devices.updated{device_added}` when a device was created.
 *
 * Unknown login and wrong password give the same code and the same work (one verification through the same
 * semaphore) and are counted by the same throttle.
 */
import type { AppContext } from "../../context.ts";
import type { LoginRequest, MeResponse, RegisterRequest } from "../../contract/auth.ts";
import type { AuthSession, DeviceInput } from "../../contract/common.ts";
import { insertHead, lockUser } from "../../db/heads.ts";
import type { RequestAuth } from "../../http/auth-guard.ts";
import { AppError } from "../../http/errors.ts";
import { newId } from "../../lib/ids.ts";
import { issueSession, sessionConfig } from "../../lib/session.ts";
import { formatIso } from "../../lib/time.ts";
import { argon2PoolFor } from "./argon2-pool.ts";
import type { Argon2Pool } from "./argon2-pool.ts";
import {
  claimFirstUser,
  countDevices,
  findDevice,
  findDeviceByHwid,
  findUser,
  findUserByLogin,
  insertDevice,
  insertUser,
  loginExists,
  readFirstUserId,
  replacePasswordHash,
  updateDeviceReport,
} from "./auth.repository.ts";
import type { DeviceRow, UserRow } from "./auth.repository.ts";
import { toAuthSession, toDeviceDto, toUserDto } from "./dto.ts";
import { hwidHash } from "./hwid.ts";
import { assertNewPassword, checkNewLogin, normalizeLogin } from "./password.ts";
import { PowGate, readPowSolution } from "./pow.ts";
import type { IssuedChallenge } from "./pow.ts";
import { newRecoveryCode } from "./recovery.ts";
import { LOGIN_THROTTLE, clearThrottle, countFailure, lockedUntil, throttledError } from "./throttle.ts";

export type AuthService = Readonly<{
  pow: PowGate;
  argon2: Argon2Pool;
  /** `GET /auth/register/challenge`. */
  challenge(): IssuedChallenge;
  /** Steps 1–2 of registration, on the raw (sanitized) body before the schema. */
  registrationGate(body: unknown): Promise<void>;
  /** Steps 3–7 of registration. */
  register(input: RegisterRequest): Promise<AuthSession>;
  login(input: LoginRequest): Promise<AuthSession>;
  /** `GET /auth/me`. */
  me(auth: RequestAuth): Promise<MeResponse>;
}>;

export type AuthServiceOptions = Readonly<{
  /** Default: a new gate with the context's `REGISTRATION_POW_*` settings. */
  pow?: PowGate;
  /** Default: the context's pool (`argon2PoolFor`). */
  argon2?: Argon2Pool;
}>;

/** The `devices` row of a device the client describes, created now. */
function newDeviceRow(userId: string, device: DeviceInput, linkedVia: "register" | "login", now: number): DeviceRow {
  return {
    id: newId(),
    user_id: userId,
    hwid_hash: hwidHash(device.hwid),
    reported_name: device.name,
    custom_name: null,
    platform: device.platform,
    os_version: device.osVersion ?? null,
    model: device.model ?? null,
    client_version: device.clientVersion ?? null,
    linked_via: linkedVia,
    linked_by_device_id: null,
    created_at: now,
    last_seen_at: now,
    last_sync_at: null,
  };
}

export function createAuthService(ctx: AppContext, options: AuthServiceOptions = {}): AuthService {
  const { env, db, clock } = ctx;
  const argon2 = options.argon2 ?? argon2PoolFor(ctx);
  const pow =
    options.pow ??
    new PowGate({
      key: ctx.keys.pow,
      baseBits: env.REGISTRATION_POW_BITS,
      softPerHour: env.REGISTRATION_POW_SOFT_PER_HOUR,
    });
  const config = sessionConfig(env, ctx.keys);

  async function registrationGate(body: unknown): Promise<void> {
    if (env.REGISTRATION === "closed") throw new AppError("registration_closed");
    if (env.REGISTRATION === "first" && (await db.run((q) => readFirstUserId(q))) !== null) {
      throw new AppError("registration_closed");
    }
    const verdict = pow.check(readPowSolution(body), clock.now());
    if (verdict === "required") throw new AppError("pow_required");
    if (verdict === "invalid") throw new AppError("pow_invalid");
  }

  async function register(input: RegisterRequest): Promise<AuthSession> {
    if (env.REGISTRATION === "closed") throw new AppError("registration_closed");
    const checked = checkNewLogin(input.login, env.RESERVED_LOGINS);
    if (!checked.ok) throw new AppError(checked.code);
    const { login } = checked;
    if (await db.run((q) => loginExists(q, login))) throw new AppError("login_taken");
    assertNewPassword(input.password, login);
    const passwordHash = await argon2.hash(input.password);
    const recovery = newRecoveryCode();

    const created = await db.write(async (q) => {
      const now = clock.now();
      const userId = newId();
      // Any creation of a user claims the slot; only mode `first` refuses when it is gone.
      const isFirst = await claimFirstUser(q, userId);
      if (!isFirst && env.REGISTRATION === "first") throw new AppError("registration_closed");
      const user: UserRow = {
        id: userId,
        login,
        password_hash: passwordHash,
        auth_version: 1,
        password_changed_at: now,
        recovery_code_hash: recovery.hash,
        recovery_code_created_at: now,
        recovery_code_confirmed_at: null,
        created_by: "self",
        deleted_at: null,
        created_at: now,
        updated_at: now,
      };
      if (!(await insertUser(q, user))) throw new AppError("login_taken");
      const device = newDeviceRow(userId, input.device, "register", now);
      await insertDevice(q, device);
      const session = await issueSession(q, { userId, deviceId: device.id, authVersion: 1, now }, config);
      await insertHead(q, userId, now);
      return { user, device, session, now };
    });

    pow.recordRegistration(created.now);
    return toAuthSession({
      ...created,
      serverId: ctx.serverId,
      newDeviceRestrictHours: env.NEW_DEVICE_RESTRICT_HOURS,
      recoveryCode: recovery.display,
    });
  }

  async function login(input: LoginRequest): Promise<AuthSession> {
    const login = normalizeLogin(input.login);
    const deviceHash = hwidHash(input.device.hwid);
    const startedAt = clock.now();
    const found = await db.read(async (q) => {
      const user = await findUserByLogin(q, login);
      const lock = await lockedUntil(q, LOGIN_THROTTLE, login, startedAt);
      const known = user === undefined ? false : (await findDeviceByHwid(q, user.id, deviceHash)) !== undefined;
      return { user, lock, known };
    });
    if (found.lock !== null && !found.known) throw throttledError(LOGIN_THROTTLE, found.lock, startedAt);

    const verified =
      found.user === undefined
        ? await argon2.verifyDummy(input.password)
        : await argon2.verify(found.user.password_hash, input.password);
    if (!verified || found.user === undefined) {
      const now = clock.now();
      const lock = await db.write((q) => countFailure(q, LOGIN_THROTTLE, login, now));
      if (lock !== null && !found.known) throw throttledError(LOGIN_THROTTLE, lock, now);
      throw new AppError("invalid_credentials");
    }

    const account = found.user;
    const rehash = argon2.needsRehash(account.password_hash) ? await argon2.hash(input.password) : null;
    const signedIn = await db.write(async (q) => {
      await lockUser(q, account.id);
      const now = clock.now();
      let user = await findUser(q, account.id);
      // Deleted, or the password changed since it was verified: the verified password is not the password any more.
      if (user?.password_hash !== account.password_hash) throw new AppError("invalid_credentials");
      if (rehash !== null && (await replacePasswordHash(q, user.id, account.password_hash, rehash, now))) {
        user = { ...user, password_hash: rehash, updated_at: now };
      }

      const known = await findDeviceByHwid(q, user.id, deviceHash);
      let device: DeviceRow | undefined;
      if (known === undefined) {
        const limit = env.MAX_DEVICES_PER_USER;
        if (limit !== null) {
          const count = await countDevices(q, user.id);
          if (count >= limit) {
            throw new AppError("device_limit_reached", { details: { deviceLimit: limit, deviceCount: count } });
          }
        }
        device = newDeviceRow(user.id, input.device, "login", now);
        await insertDevice(q, device);
      } else {
        await updateDeviceReport(
          q,
          known.id,
          {
            reportedName: input.device.name,
            platform: input.device.platform,
            osVersion: input.device.osVersion,
            model: input.device.model,
            clientVersion: input.device.clientVersion,
          },
          now,
        );
        device = await findDevice(q, user.id, known.id);
        if (device === undefined) throw new Error("the device disappeared under lockUser");
      }

      await clearThrottle(q, LOGIN_THROTTLE, login);
      const session = await issueSession(
        q,
        { userId: user.id, deviceId: device.id, authVersion: user.auth_version, now, replaceDeviceTokens: !!known },
        config,
      );
      return { user, device, session, now, added: known === undefined };
    });

    if (signedIn.added) {
      ctx.live.publish(signedIn.user.id, "devices.updated", { reason: "device_added", deviceId: signedIn.device.id });
    }
    return toAuthSession({
      ...signedIn,
      serverId: ctx.serverId,
      newDeviceRestrictHours: env.NEW_DEVICE_RESTRICT_HOURS,
    });
  }

  async function me(auth: RequestAuth): Promise<MeResponse> {
    const rows = await db.read(async (q) => ({
      user: await findUser(q, auth.userId),
      device: await findDevice(q, auth.userId, auth.deviceId),
    }));
    if (rows.user === undefined || rows.device === undefined) throw new AppError("session_revoked");
    const now = clock.now();
    return {
      user: toUserDto(rows.user),
      device: toDeviceDto(rows.device, {
        currentDeviceId: auth.deviceId,
        now,
        newDeviceRestrictHours: env.NEW_DEVICE_RESTRICT_HOURS,
      }),
      serverId: ctx.serverId,
      serverTime: formatIso(now),
    };
  }

  return Object.freeze({
    pow,
    argon2,
    challenge: () => pow.issue(clock.now()),
    registrationGate,
    register,
    login,
    me,
  });
}
