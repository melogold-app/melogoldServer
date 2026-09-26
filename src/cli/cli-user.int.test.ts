/**
 * `melogold user …` against a running app on the same database, both dialects (PLAN T3.1 `cli.int`):
 * - `user add` in mode `first` closes registration, and the generated password signs in;
 * - `reset-password` raises `auth_version`, signs every device out and prints a new recovery code;
 * - `delete` needs `--yes` or the login typed again; the account can no longer sign in and leaves the list;
 * - `list`, `devices`, `revoke-device`;
 * - passwords come only from a terminal (or `--generate-password`), twice, under the password policy.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { parseEnv } from "../config/env.ts";
import type { Env } from "../config/env.ts";
import { captureOutput } from "../test/cli-output.ts";
import { assertError, createTestApp, json } from "../test/test-app.ts";
import type { TestApp } from "../test/test-app.ts";
import { TEST_DIALECT } from "../test/test-db.ts";
import { EXIT_FAILURE, runCli } from "./index.ts";
import type { Prompter } from "./password.ts";

/** Argon2 at its minimum cost: the tests hash real passwords. */
const FAST_ARGON2 = { ARGON2_MEMORY_KIB: "19456", ARGON2_TIME_COST: "2" };

let t: TestApp;
let env: Env;

before(async () => {
  t = await createTestApp({ env: { ...FAST_ARGON2, REGISTRATION: "first" } });
  env = parseEnv({ ...t.database.envVars, ...FAST_ARGON2, REGISTRATION: "first" });
});

after(async () => {
  await t.close();
});

/** A prompter that answers from a script, in order. */
function scripted(...answers: string[]): Prompter {
  const next = () => {
    const answer = answers.shift();
    if (answer === undefined) return Promise.reject(new Error("the test prompter ran out of answers"));
    return Promise.resolve(answer);
  };
  return { hidden: next, visible: next };
}

async function cli(args: readonly string[], prompter: Prompter = scripted()) {
  const captured = captureOutput();
  const code = await runCli(args, captured.output, { env, prompter });
  return { code, stdout: captured.stdout(), stderr: captured.stderr() };
}

function field(stdout: string, name: string): string {
  const match = new RegExp(`^${name}: (.+)$`, "m").exec(stdout);
  assert.ok(match?.[1], `no "${name}:" line in:\n${stdout}`);
  return match[1];
}

async function signIn(login: string, password: string) {
  return t.app.inject({
    method: "POST",
    url: "/auth/login",
    payload: {
      login,
      password,
      device: { hwid: randomBytes(32).toString("hex"), name: "Google Pixel 8", platform: "android" },
    },
  });
}

describe(`melogold user (${TEST_DIALECT})`, () => {
  let ownerPassword = "";

  test("user add in mode first creates the owner, closes registration, and the generated password signs in", async () => {
    const added = await cli(["user", "add", "Anna", "--generate-password"]);
    assert.equal(added.code, 0, added.stderr);
    assert.match(
      added.stdout,
      /^account anna created \(the first account: registration mode "first" is closed now\)$/m,
    );
    ownerPassword = field(added.stdout, "password");
    assert.match(ownerPassword, /^[a-zA-Z2-9]{5}(-[a-zA-Z2-9]{5}){3}$/);
    assert.match(field(added.stdout, "recovery code"), /^[0-9A-Z]{4}(-[0-9A-Z]{4}){4}$/);

    const register = await t.app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        login: "latecomer",
        password: "две собаки и кот",
        device: { hwid: randomBytes(32).toString("hex"), name: "Pixel", platform: "android" },
      },
    });
    assertError(register, 403, "registration_closed");

    const login = await signIn("anna", ownerPassword);
    assert.equal(login.statusCode, 200, login.body);
    assert.equal((json(login).user as { login: string }).login, "anna");
  });

  test("user add: a taken login, a typed password under the policy, and passwords that differ", async () => {
    const taken = await cli(["user", "add", "anna", "--generate-password"]);
    assert.equal(taken.code, EXIT_FAILURE);
    assert.match(taken.stderr, /Login is taken/);

    const short = await cli(["user", "add", "short-one"], scripted("abc", "abc"));
    assert.equal(short.code, EXIT_FAILURE);
    assert.match(short.stderr, /Password is too short \(minLength: \d+\)/);

    const differ = await cli(["user", "add", "second"], scripted("две собаки и кот", "две собаки и кит"));
    assert.equal(differ.code, EXIT_FAILURE);
    assert.match(differ.stderr, /the passwords differ/);

    const typed = await cli(["user", "add", "second"], scripted("две собаки и кот", "две собаки и кот"));
    assert.equal(typed.code, 0, typed.stderr);
    assert.doesNotMatch(typed.stdout, /^password:/m, "a typed password is never printed");
    assert.doesNotMatch(typed.stdout, /first account/);
    assert.equal((await signIn("second", "две собаки и кот")).statusCode, 200);
  });

  test("without a terminal and without --generate-password there is no password", async () => {
    const captured = captureOutput();
    const code = await runCli(["user", "add", "nobody"], captured.output, { env });
    assert.equal(code, EXIT_FAILURE);
    assert.match(captured.stderr(), /a password is read only from a terminal/);
  });

  test("user list and user devices show the accounts and their devices", async () => {
    const list = await cli(["user", "list", "--usage", "--json"]);
    assert.equal(list.code, 0, list.stderr);
    const accounts = JSON.parse(list.stdout) as { login: string; createdBy: string; devices: number; usage: object }[];
    const owner = accounts.find((account) => account.login === "anna");
    assert.ok(owner);
    assert.equal(owner.createdBy, "admin");
    assert.equal(owner.devices, 1);
    assert.deepEqual(owner.usage, {
      likes: 0,
      bookmarks: 0,
      playlists: 0,
      playlistItems: 0,
      historyPlays: 0,
      lyrics: 0,
    });

    const text = await cli(["user", "list"]);
    assert.match(text.stdout, /^LOGIN +CREATED +BY +DEVICES +LAST SEEN$/m);
    assert.match(text.stdout, /^anna +\d{4}-\d{2}-\d{2} \d{2}:\d{2} +admin +1 /m);

    const devices = await cli(["user", "devices", "anna", "--json"]);
    assert.equal(devices.code, 0, devices.stderr);
    const [device] = JSON.parse(devices.stdout) as { name: string; platform: string; linkedVia: string }[];
    assert.deepEqual(
      { name: device?.name, platform: device?.platform, linkedVia: device?.linkedVia },
      { name: "Google Pixel 8", platform: "android", linkedVia: "login" },
    );

    const unknown = await cli(["user", "devices", "ghost"]);
    assert.equal(unknown.code, EXIT_FAILURE);
    assert.match(unknown.stderr, /no active account "ghost"/);
  });

  test("user revoke-device signs one device out", async () => {
    const signedIn = await signIn("second", "две собаки и кот");
    const deviceId = (json(signedIn).device as { id: string }).id;
    const refreshToken = (json(signedIn).tokens as { refreshToken: string }).refreshToken;

    const revoked = await cli(["user", "revoke-device", "second", deviceId]);
    assert.equal(revoked.code, 0, revoked.stderr);
    const refresh = await t.app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken, device: { hwid: randomBytes(32).toString("hex") } },
    });
    assert.equal(refresh.statusCode, 401, refresh.body);

    const again = await cli(["user", "revoke-device", "second", deviceId]);
    assert.equal(again.code, EXIT_FAILURE);
    assert.match(again.stderr, /has no device/);
  });

  test("user reset-password: new password and code, auth_version up, every device signed out", async () => {
    const before = await t.db.run((q) =>
      q.selectFrom("users").select(["auth_version"]).where("login", "=", "anna").executeTakeFirstOrThrow(),
    );
    const reset = await cli(["user", "reset-password", "anna", "--generate-password"]);
    assert.equal(reset.code, 0, reset.stderr);
    assert.match(reset.stdout, /^password of anna reset, \d+ devices signed out$/m);
    const newPassword = field(reset.stdout, "password");
    field(reset.stdout, "recovery code");

    const after = await t.db.run((q) =>
      q.selectFrom("users").select(["id", "auth_version"]).where("login", "=", "anna").executeTakeFirstOrThrow(),
    );
    assert.equal(after.auth_version, before.auth_version + 1);
    const devices = await t.db.run((q) =>
      q.selectFrom("devices").select("id").where("user_id", "=", after.id).execute(),
    );
    assert.deepEqual(devices, []);
    assertError(await signIn("anna", ownerPassword), 401, "invalid_credentials");
    assert.equal((await signIn("anna", newPassword)).statusCode, 200);
  });

  test("user delete needs --yes or the login typed again", async () => {
    const wrong = await cli(["user", "delete", "second"], scripted("secnod"));
    assert.equal(wrong.code, EXIT_FAILURE);
    assert.match(wrong.stderr, /cancelled/);
    assert.equal((await signIn("second", "две собаки и кот")).statusCode, 200);

    const confirmed = await cli(["user", "delete", "second"], scripted("second"));
    assert.equal(confirmed.code, 0, confirmed.stderr);
    assert.match(confirmed.stdout, /^account second deleted, \d+ devices signed out/m);
    assertError(await signIn("second", "две собаки и кот"), 401, "invalid_credentials");

    const list = await cli(["user", "list", "--json"]);
    assert.deepEqual(
      (JSON.parse(list.stdout) as { login: string }[]).map((account) => account.login),
      ["anna"],
    );

    const gone = await cli(["user", "delete", "second", "--yes"]);
    assert.equal(gone.code, EXIT_FAILURE);
    assert.match(gone.stderr, /no active account "second"/);
  });
});
