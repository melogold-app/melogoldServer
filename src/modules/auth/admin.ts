/**
 * Accounts made by the administrator (`melogold user add`; DESIGN §7.3 step 11, §7.4; PLAN T3.1): the login and
 * password rules of `POST /auth/register`, argon2 outside any transaction, then one transaction that
 *
 * 1. claims the first-user slot (`server_meta.first_user_id`), so in mode `first` registration closes as soon as the
 *    owner exists (the installer creates the owner **before** the port is published, DESIGN M8);
 * 2. inserts the user with `created_by = 'admin'` (`ON CONFLICT (login) DO NOTHING` → `login_taken`);
 * 3. inserts its sync head.
 *
 * No device is created: the owner signs in from a client with the password.
 */
import type { Env } from "../../config/env.ts";
import type { Db } from "../../db/index.ts";
import { insertHead } from "../../db/heads.ts";
import { AppError } from "../../http/errors.ts";
import type { Clock } from "../../lib/clock.ts";
import { newId } from "../../lib/ids.ts";
import { argon2PoolFor } from "./argon2-pool.ts";
import { claimFirstUser, insertUser, loginExists } from "./auth.repository.ts";
import { assertNewPassword, checkNewLogin } from "./password.ts";
import { newRecoveryCode } from "./recovery.ts";

export type AdminDeps = Readonly<{
  db: Pick<Db, "run" | "write">;
  clock: Pick<Clock, "now">;
  env: Env;
}>;

export type CreatedAccount = Readonly<{
  userId: string;
  login: string;
  /** The recovery code to show once (`XXXX-XXXX-XXXX-XXXX-XXXX`). */
  recoveryCode: string;
  /** Whether this is the first account of the server (it took the first-user slot). */
  first: boolean;
}>;

/**
 * Creates an account without a device (steps 1–3 above).
 * @throws AppError `invalid_login_format`, `login_taken` or a `password_*` refusal.
 */
export async function createUserByAdmin(
  deps: AdminDeps,
  input: Readonly<{ login: string; password: string }>,
): Promise<CreatedAccount> {
  const checked = checkNewLogin(input.login, deps.env.RESERVED_LOGINS);
  if (!checked.ok) throw new AppError(checked.code);
  const { login } = checked;
  if (await deps.db.run((q) => loginExists(q, login))) throw new AppError("login_taken");
  assertNewPassword(input.password, login);
  const passwordHash = await argon2PoolFor(deps).hash(input.password);
  const recovery = newRecoveryCode();

  const userId = newId();
  const first = await deps.db.write(async (q) => {
    const now = deps.clock.now();
    const isFirst = await claimFirstUser(q, userId);
    const inserted = await insertUser(q, {
      id: userId,
      login,
      password_hash: passwordHash,
      auth_version: 1,
      password_changed_at: now,
      recovery_code_hash: recovery.hash,
      recovery_code_created_at: now,
      recovery_code_confirmed_at: null,
      created_by: "admin",
      deleted_at: null,
      created_at: now,
      updated_at: now,
    });
    if (!inserted) throw new AppError("login_taken");
    await insertHead(q, userId, now);
    return isFirst;
  });
  return Object.freeze({ userId, login, recoveryCode: recovery.display, first });
}
