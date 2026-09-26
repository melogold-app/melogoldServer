/**
 * `melogold user …` (DESIGN §7.4, PLAN T3.1): the administrator's account commands. The services live in the
 * modules (`auth/admin.ts`, `account/admin.ts`); this file reads passwords and confirmations and prints results.
 *
 * The lines `password: …` and `recovery code: …` of `user add` and `user reset-password` are stable: the installer
 * reads them to show the owner's credentials in its summary.
 */
import type { Env } from "../config/env.ts";
import { isAppError } from "../http/errors.ts";
import type { AppError } from "../http/errors.ts";
import { formatIso } from "../lib/time.ts";
import {
  deleteAccountByAdmin,
  listAccountDevices,
  listAccounts,
  resetPasswordByAdmin,
  revokeDeviceByAdmin,
} from "../modules/account/admin.ts";
import type { AccountListEntry } from "../modules/account/admin.ts";
import { createUserByAdmin } from "../modules/auth/admin.ts";
import { CliError, EXIT_FAILURE, EXIT_OK } from "./io.ts";
import type { CliOutput } from "./io.ts";
import { askNewPassword, generatePassword } from "./password.ts";
import type { Prompter } from "./password.ts";
import { withRuntime } from "./runtime.ts";
import type { CliRuntime, OpenRuntimeOptions } from "./runtime.ts";

const RECOVERY_NOTE =
  "Keep the recovery code somewhere safe: it is shown only now. With it the account's password can be reset " +
  "from any Melogold client.\n";

/** An `AppError` of a service as the text of a `CliError` (the registry's message and its details). */
function explain(error: AppError): CliError {
  const details = Object.entries(error.details)
    .map(
      ([key, value]) =>
        `${key}: ${typeof value === "string" || typeof value === "number" ? String(value) : JSON.stringify(value)}`,
    )
    .join(", ");
  return new CliError(details === "" ? error.message : `${error.message} (${details})`);
}

async function withAccounts<T>(
  env: Env,
  options: OpenRuntimeOptions,
  body: (runtime: CliRuntime) => Promise<T>,
): Promise<T> {
  try {
    return await withRuntime(env, options, body);
  } catch (error) {
    if (isAppError(error)) throw explain(error);
    throw error;
  }
}

async function newPassword(prompter: Prompter, login: string, generate: boolean): Promise<string> {
  return generate ? generatePassword() : askNewPassword(prompter, login);
}

/** `user add <login> [--generate-password]`. */
export async function userAddCommand(
  env: Env,
  output: CliOutput,
  options: OpenRuntimeOptions,
  prompter: Prompter,
  input: Readonly<{ login: string; generate: boolean }>,
): Promise<number> {
  const password = await newPassword(prompter, input.login, input.generate);
  const created = await withAccounts(env, options, (runtime) =>
    createUserByAdmin({ db: runtime.db, clock: runtime.clock, env }, { login: input.login, password }),
  );
  const firstNote =
    created.first && env.REGISTRATION === "first"
      ? ' (the first account: registration mode "first" is closed now)'
      : "";
  output.out(`account ${created.login} created${firstNote}\n`);
  if (input.generate) output.out(`password: ${password}\n`);
  output.out(`recovery code: ${created.recoveryCode}\n${RECOVERY_NOTE}`);
  return EXIT_OK;
}

/** `user reset-password <login> [--generate-password]`. */
export async function userResetPasswordCommand(
  env: Env,
  output: CliOutput,
  options: OpenRuntimeOptions,
  prompter: Prompter,
  input: Readonly<{ login: string; generate: boolean }>,
): Promise<number> {
  const password = await newPassword(prompter, input.login, input.generate);
  const reset = await withAccounts(env, options, (runtime) =>
    resetPasswordByAdmin({ db: runtime.db, clock: runtime.clock, env }, { login: input.login, password }),
  );
  output.out(`password of ${reset.login} reset, ${reset.signedOutDevices} devices signed out\n`);
  if (input.generate) output.out(`password: ${password}\n`);
  output.out(`recovery code: ${reset.recoveryCode}\n${RECOVERY_NOTE}`);
  return EXIT_OK;
}

/** `user delete <login> [--yes]`: without `--yes` the login must be typed again on the terminal. */
export async function userDeleteCommand(
  env: Env,
  output: CliOutput,
  options: OpenRuntimeOptions,
  prompter: Prompter,
  input: Readonly<{ login: string; yes: boolean }>,
): Promise<number> {
  if (!input.yes) {
    const typed = await prompter.visible(
      `This deletes the account ${input.login} and its whole library on this server. Type the login to confirm: `,
    );
    if (typed.trim().toLowerCase() !== input.login.trim().toLowerCase()) throw new CliError("cancelled");
  }
  const signedOut = await withAccounts(env, options, (runtime) =>
    deleteAccountByAdmin({ db: runtime.db, clock: runtime.clock, env }, input.login),
  );
  output.out(`account ${input.login} deleted, ${signedOut} devices signed out; its data is purged within 15 minutes\n`);
  return EXIT_OK;
}

/** `YYYY-MM-DD HH:MM` (UTC) or `—`. */
function shortTime(ms: number | null): string {
  return ms === null ? "—" : formatIso(ms).slice(0, 16).replace("T", " ");
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd();
  return `${[line(header), ...rows.map(line)].join("\n")}\n`;
}

/** `user list [--usage] [--json]`. */
export async function userListCommand(
  env: Env,
  output: CliOutput,
  options: OpenRuntimeOptions,
  input: Readonly<{ usage: boolean; json: boolean }>,
): Promise<number> {
  const accounts = await withAccounts(env, options, (runtime) => listAccounts(runtime, { usage: input.usage }));
  if (input.json) {
    output.out(`${JSON.stringify(accounts)}\n`);
    return EXIT_OK;
  }
  if (accounts.length === 0) {
    output.out("no accounts yet: melogold user add <login>\n");
    return EXIT_OK;
  }
  const usageHeader = input.usage ? ["LIKES", "PLAYLISTS", "IN PLAYLISTS", "HISTORY", "LYRICS"] : [];
  const usageCells = (entry: AccountListEntry) =>
    entry.usage === undefined
      ? []
      : [
          entry.usage.likes,
          entry.usage.playlists,
          entry.usage.playlistItems,
          entry.usage.historyPlays,
          entry.usage.lyrics,
        ].map(String);
  output.out(
    table(
      ["LOGIN", "CREATED", "BY", "DEVICES", "LAST SEEN", ...usageHeader],
      accounts.map((entry) => [
        entry.login,
        shortTime(entry.createdAt),
        entry.createdBy,
        String(entry.devices),
        shortTime(entry.lastSeenAt),
        ...usageCells(entry),
      ]),
    ),
  );
  return EXIT_OK;
}

/** `user devices <login> [--json]`. */
export async function userDevicesCommand(
  env: Env,
  output: CliOutput,
  options: OpenRuntimeOptions,
  input: Readonly<{ login: string; json: boolean }>,
): Promise<number> {
  const devices = await withAccounts(env, options, (runtime) => listAccountDevices(runtime, input.login));
  const entries = devices.map((device) => ({
    id: device.id,
    name: device.custom_name ?? device.reported_name,
    platform: device.platform,
    model: device.model,
    osVersion: device.os_version,
    clientVersion: device.client_version,
    linkedVia: device.linked_via,
    createdAt: device.created_at,
    lastSeenAt: device.last_seen_at,
    lastSyncAt: device.last_sync_at,
  }));
  if (input.json) {
    output.out(`${JSON.stringify(entries)}\n`);
    return EXIT_OK;
  }
  if (entries.length === 0) {
    output.out(`${input.login} has no devices signed in\n`);
    return EXIT_OK;
  }
  output.out(
    table(
      ["ID", "NAME", "PLATFORM", "CLIENT", "LINKED", "LAST SEEN", "LAST SYNC"],
      entries.map((entry) => [
        entry.id,
        entry.name,
        [entry.platform, entry.model, entry.osVersion].filter((part) => part !== null && part !== "").join(" "),
        entry.clientVersion ?? "—",
        entry.linkedVia,
        shortTime(entry.lastSeenAt),
        shortTime(entry.lastSyncAt),
      ]),
    ),
  );
  return EXIT_OK;
}

/** `user revoke-device <login> <device-id>`. */
export async function userRevokeDeviceCommand(
  env: Env,
  output: CliOutput,
  options: OpenRuntimeOptions,
  input: Readonly<{ login: string; deviceId: string }>,
): Promise<number> {
  const removed = await withAccounts(env, options, (runtime) =>
    revokeDeviceByAdmin({ db: runtime.db, clock: runtime.clock, env }, input.login, input.deviceId),
  );
  if (!removed) {
    output.err(`melogold: ${input.login} has no device ${input.deviceId}\n`);
    return EXIT_FAILURE;
  }
  output.out(`device ${input.deviceId} signed out; its app asks to sign in again within a minute\n`);
  return EXIT_OK;
}
