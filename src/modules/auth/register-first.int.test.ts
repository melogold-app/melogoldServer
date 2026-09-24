/**
 * `POST /auth/register` and registration mode `first` end to end (API §4.3, DESIGN §4.2, PLAN T1.1 acceptance
 * `register-first.int`): the first successful creation of a user claims `server_meta.first_user_id` through
 * `ON CONFLICT DO NOTHING RETURNING`, whichever path creates it — the HTTP route or a user created directly (as the
 * CLI would). Mode `closed` is covered too (the simplest case of the same gate).
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { createUser } from "../../test/factories.ts";
import { assertError, createTestApp, json } from "../../test/test-app.ts";
import type { TestApp } from "../../test/test-app.ts";

/** Argon2 at its minimum cost: registration tests hash real passwords and would otherwise be slow. */
const FAST_ARGON2 = { ARGON2_MEMORY_KIB: "19456", ARGON2_TIME_COST: "2" };

function device(hwid = randomBytes(32).toString("hex")) {
  return { hwid, name: "Google Pixel 8", platform: "android" };
}

function registerBody(login: string) {
  return { login, password: "две собаки и кот", device: device() };
}

describe("POST /auth/register, mode `first` (the default)", () => {
  let t: TestApp;

  before(async () => {
    t = await createTestApp({ env: FAST_ARGON2 });
  });

  after(async () => {
    await t.close();
  });

  test("two parallel registrations: exactly one 201, the other registration_closed; first_user_id is the winner", async () => {
    const [a, b] = await Promise.all([
      t.app.inject({ method: "POST", url: "/auth/register", payload: registerBody("Maxim") }),
      t.app.inject({ method: "POST", url: "/auth/register", payload: registerBody("second-user") }),
    ]);
    const statuses = [a.statusCode, b.statusCode].sort();
    assert.deepEqual(statuses, [201, 403]);
    const [winner, loser] = a.statusCode === 201 ? [a, b] : [b, a];

    const body = json(winner);
    assert.equal(body.recoveryCode !== null, true, "register hands out a recovery code");
    assert.equal((body.device as Record<string, unknown>).linkedVia, "register");
    assert.ok(body.tokens);
    assertError(loser, 403, "registration_closed");

    const winnerLogin = (json(winner).user as Record<string, unknown>).login as string;
    const row = await t.db.run((q) =>
      q.selectFrom("server_meta").select("value").where("key", "=", "first_user_id").executeTakeFirstOrThrow(),
    );
    const owner = await t.db.run((q) =>
      q.selectFrom("users").select("login").where("id", "=", row.value).executeTakeFirstOrThrow(),
    );
    assert.equal(owner.login, winnerLogin);
  });

  test("a third registration, once the slot is claimed, is also registration_closed", async () => {
    const response = await t.app.inject({ method: "POST", url: "/auth/register", payload: registerBody("third-user") });
    assertError(response, 403, "registration_closed");
  });
});

describe("POST /auth/register, mode `first`: a user created outside HTTP (as the CLI does) also closes it", () => {
  let t: TestApp;

  before(async () => {
    t = await createTestApp({ env: FAST_ARGON2 });
    await createUser(t.db, { login: "owner", firstUser: true, createdBy: "admin" });
  });

  after(async () => {
    await t.close();
  });

  test("registration is closed for everybody else", async () => {
    const response = await t.app.inject({ method: "POST", url: "/auth/register", payload: registerBody("Maxim") });
    assertError(response, 403, "registration_closed");
  });
});

describe("POST /auth/register, mode `closed`", () => {
  let t: TestApp;

  before(async () => {
    t = await createTestApp({ env: { ...FAST_ARGON2, REGISTRATION: "closed" } });
  });

  after(async () => {
    await t.close();
  });

  test("always registration_closed, even for the very first user", async () => {
    const response = await t.app.inject({ method: "POST", url: "/auth/register", payload: registerBody("Maxim") });
    assertError(response, 403, "registration_closed");
  });
});

describe("POST /auth/register, mode `open`", () => {
  let t: TestApp;

  before(async () => {
    t = await createTestApp({ env: { ...FAST_ARGON2, REGISTRATION: "open" } });
  });

  after(async () => {
    await t.close();
  });

  test("registration never closes on its own", async () => {
    const first = await t.app.inject({ method: "POST", url: "/auth/register", payload: registerBody("Maxim") });
    assert.equal(first.statusCode, 201);
    const second = await t.app.inject({ method: "POST", url: "/auth/register", payload: registerBody("second-user") });
    assert.equal(second.statusCode, 201);
  });
});
