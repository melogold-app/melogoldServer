/**
 * `GET /auth/me/events` over a real HTTP connection, on both dialects (PLAN T1.5 acceptance, DESIGN §10 M5):
 * - the first frame is `retry: 5000`, then `system.connected`; events are `id:` + `data:` without `event:`; the
 *   transport headers of API §6; never compressed;
 * - a heartbeat comment every `SSE_HEARTBEAT_SECONDS`;
 * - the stream closes at the `exp` of its token (a newer stream of the device stays);
 * - a device deleted in a neighbouring process (a direct `DELETE` from another process or connection) gets
 *   `session.invalidated{device_revoked}` and the close at the next heartbeat; a raised `auth_version` closes without
 *   an event; a deleted account gets `account_deleted`;
 * - the fifth stream of a device evicts the first;
 * - `sync.changed` is coalesced for 2 s;
 * - `app.close()` finishes while streams are open.
 *
 * The live module's timers (coalescing, token expiry, heartbeat) are fakes injected through `liveTimers`, and the
 * clock is manual, so every beat and expiry happens exactly when a test fires it.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { buildApp, createFastify } from "../../app.ts";
import { deriveSubkeys } from "../../config/secret-key.ts";
import { createAppContext } from "../../context.ts";
import type { AppContext } from "../../context.ts";
import type { Db } from "../../db/index.ts";
import type { DiskGuard } from "../../http/disk-guard.ts";
import { ManualClock } from "../../lib/clock.ts";
import { formatIso } from "../../lib/time.ts";
import { createAccount, createDevice, createSession } from "../../test/factories.ts";
import type { TestAccount } from "../../test/factories.ts";
import { TEST_MASTER_KEY, TEST_T0 } from "../../test/test-app.ts";
import { TEST_DIALECT, createMigratedTestDatabase } from "../../test/test-db.ts";
import type { TestDatabase } from "../../test/test-db.ts";
import { initServerIdentity } from "../server/server.service.ts";
import type { LiveTimers } from "./live.hub.ts";
import type { LiveEvent } from "./live.events.ts";

const HEARTBEAT_MS = 25_000; // SSE_HEARTBEAT_SECONDS default
const TTL_MS = 900_000; // ACCESS_TOKEN_TTL_SECONDS default
const COALESCE_MS = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------------------------------

/** Timers of the live module that fire only when a test says so. */
class FakeTimers implements LiveTimers {
  #next = 1;
  readonly pending = new Map<number, { callback: () => void; ms: number }>();

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.#next++;
    this.pending.set(id, { callback, ms });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  delays(): number[] {
    return [...this.pending.values()].map((timer) => timer.ms);
  }

  /** The id of the newest pending timer of this delay. */
  latest(ms: number): number {
    const ids = [...this.pending.entries()].filter(([, timer]) => timer.ms === ms).map(([id]) => id);
    const id = ids.at(-1);
    assert.ok(id !== undefined, `no pending timer of ${ms} ms (pending: ${this.delays().join(", ")})`);
    return id;
  }

  /** Fires one timer by id. */
  fireId(id: number): void {
    const timer = this.pending.get(id);
    assert.ok(timer, `timer ${id} is not pending`);
    this.pending.delete(id);
    timer.callback();
  }

  /** Fires every pending timer of this delay; returns how many. */
  fire(ms: number): number {
    const due = [...this.pending.entries()].filter(([, timer]) => timer.ms === ms);
    for (const [id] of due) this.pending.delete(id);
    for (const [, timer] of due) timer.callback();
    return due.length;
  }
}

const neverFull: DiskGuard = Object.freeze({
  check: () => Promise.resolve(null),
  status: () => null,
  isFull: () => false,
  assertWritable: () => undefined,
  start: () => undefined,
  stop: () => undefined,
});

type SseApp = Readonly<{
  app: FastifyInstance;
  ctx: AppContext;
  db: Db;
  database: TestDatabase;
  clock: ManualClock;
  timers: FakeTimers;
  port: number;
  close(): Promise<void>;
}>;

/** Like `createTestApp`, with the live timers injected, listening on a real port. */
async function createSseApp(): Promise<SseApp> {
  const { database, db } = await createMigratedTestDatabase({
    env: { LOG_LEVEL: "silent", RATE_LIMIT_ENABLED: "false", HTTP_COMPRESSION: "true" },
  });
  const clock = new ManualClock(TEST_T0);
  const timers = new FakeTimers();
  const serverId = await initServerIdentity(db, clock.now());
  const ctx = createAppContext({
    env: database.env,
    db,
    serverId,
    keys: deriveSubkeys(TEST_MASTER_KEY, serverId),
    clock,
    random: () => 0,
    diskGuard: neverFull,
    liveTimers: timers,
  });
  const app = await buildApp(ctx, { app: createFastify(database.env) });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = app.server.address() as AddressInfo;
  let closed = false;
  return Object.freeze({
    app,
    ctx,
    db,
    database,
    clock,
    timers,
    port,
    close: async () => {
      if (closed) return;
      closed = true;
      await app.close();
      await ctx.devices.idle();
      await db.destroy();
      await database.cleanup();
    },
  });
}

/** Runs one statement (`?` placeholders) from **another process** (SQLite) or another connection (PostgreSQL). */
async function writeElsewhere(database: TestDatabase, statement: string, params: readonly (string | number)[]) {
  if (TEST_DIALECT === "sqlite") {
    const script = `
      import Database from "better-sqlite3";
      const db = new Database(process.argv[1], { timeout: 10000 });
      db.pragma("foreign_keys = ON");
      const info = db.prepare(process.argv[2]).run(...JSON.parse(process.argv[3]));
      db.close();
      if (info.changes !== 1) throw new Error("expected one changed row, got " + info.changes);
    `;
    await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script, database.location, statement, JSON.stringify(params)],
      { cwd: new URL("../../..", import.meta.url) },
    );
    return;
  }
  let index = 0;
  const text = statement.replace(/\?/g, () => `$${++index}`);
  const client = new pg.Client({ connectionString: database.url });
  await client.connect();
  try {
    const result = await client.query(text, [...params]);
    assert.equal(result.rowCount, 1);
  } finally {
    await client.end();
  }
}

/** `promise`, or a failure after `ms` of real time (the timer is cleared, so it never holds the process). */
async function within<T>(promise: Promise<T>, ms: number, what: () => string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(what()));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Polls until `predicate` holds (real time; the fakes only drive the live module). */
async function until(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** One SSE connection of a test, reading the raw text as it arrives. */
class SseClient {
  readonly request: ClientRequest;
  readonly response: IncomingMessage;
  readonly ended: Promise<void>;
  text = "";
  #ended = false;

  private constructor(request: ClientRequest, response: IncomingMessage) {
    this.request = request;
    this.response = response;
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => {
      this.text += chunk;
    });
    this.ended = new Promise((resolve) => {
      const done = () => {
        this.#ended = true;
        resolve();
      };
      response.once("end", done);
      response.once("close", done);
    });
  }

  static open(
    port: number,
    token: string | null,
    options: Readonly<{ headers?: Record<string, string>; method?: "GET" | "HEAD" }> = {},
  ): Promise<SseClient> {
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/auth/me/events",
          method: options.method ?? "GET",
          agent: false,
          headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...options.headers },
        },
        (response) => {
          resolve(new SseClient(request, response));
        },
      );
      request.on("error", reject); // after the response arrived: a reset by destroy(), ignored
      request.end();
    });
  }

  /** Opens a stream and waits for `system.connected`. */
  static async connect(port: number, token: string): Promise<SseClient> {
    const client = await SseClient.open(port, token);
    assert.equal(client.response.statusCode, 200, client.text);
    await client.waitFor(() => client.events().length >= 1, "system.connected");
    return client;
  }

  get isEnded(): boolean {
    return this.#ended;
  }

  /** Complete frames (text between blank lines). */
  frames(): string[] {
    return this.text.split("\n\n").slice(0, -1);
  }

  events(): LiveEvent[] {
    return this.frames()
      .filter((frame) => frame.startsWith("id: "))
      .map((frame) => {
        const [idLine, dataLine, ...rest] = frame.split("\n");
        assert.deepEqual(rest, [], frame);
        assert.ok(dataLine !== undefined, frame);
        assert.ok(dataLine.startsWith("data: "), frame);
        const event = JSON.parse(dataLine.slice("data: ".length)) as LiveEvent;
        assert.equal(idLine, `id: ${event.id}`);
        return event;
      });
  }

  types(): string[] {
    return this.events().map((event) => event.type);
  }

  async waitFor(predicate: () => boolean, what: string): Promise<void> {
    await until(predicate, `${what}; received ${JSON.stringify(this.text)}`);
  }

  async waitForEnd(): Promise<void> {
    await within(this.ended, 5000, () => `the stream did not end; received ${JSON.stringify(this.text)}`);
  }

  destroy(): void {
    this.request.destroy();
  }
}

async function closeClients(t: SseApp, clients: readonly SseClient[]): Promise<void> {
  for (const client of clients) client.destroy();
  await until(() => t.ctx.live.count() === 0, "every stream forgotten");
}

// ---------------------------------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------------------------------

let t: SseApp;

before(async () => {
  t = await createSseApp();
});

after(async () => {
  await t.close();
});

async function newAccount(): Promise<TestAccount> {
  return createAccount(t.ctx);
}

/** A second device of the account with its own session. */
async function secondDevice(account: TestAccount) {
  const device = await createDevice(t.db, account.user.id, { now: t.clock.now(), name: "MacBook Air" });
  const session = await createSession(t.ctx, { userId: account.user.id, deviceId: device.id });
  return { device, token: session.tokens.accessToken };
}

describe("GET /auth/me/events: frames and headers (API §6)", () => {
  test("first frame retry: 5000, then system.connected; events are id + data without event:", async () => {
    const account = await newAccount();
    const client = await SseClient.open(t.port, account.session.tokens.accessToken, {
      headers: { "accept-encoding": "gzip", "x-request-id": "sse-test-00001", "last-event-id": "whatever" },
    });
    assert.equal(client.response.statusCode, 200);
    const headers = client.response.headers;
    assert.equal(headers["content-type"], "text/event-stream; charset=utf-8");
    assert.equal(headers["cache-control"], "no-store, no-transform");
    assert.equal(headers["x-accel-buffering"], "no");
    assert.equal(headers["x-request-id"], "sse-test-00001");
    assert.equal(headers["content-encoding"], undefined, "SSE is never compressed (API §1.2)");
    assert.equal(headers["x-content-type-options"], "nosniff");

    await client.waitFor(() => client.events().length === 1, "system.connected");
    assert.ok(client.text.startsWith("retry: 5000\n\n"), client.text);
    const [retry, connectedFrame] = client.frames();
    assert.equal(retry, "retry: 5000");
    const match = /^id: ([^\n]+)\ndata: ([^\n]+)$/.exec(connectedFrame ?? "");
    assert.ok(match, connectedFrame);
    assert.match(match[1] ?? "", UUID);
    assert.deepEqual(JSON.parse(match[2] ?? ""), {
      id: match[1],
      type: "system.connected",
      at: formatIso(t.clock.now()),
      payload: { heartbeatMs: HEARTBEAT_MS, retryMs: 5000 },
    });

    t.ctx.live.publish(account.user.id, "devices.updated", { reason: "device_added", deviceId: null });
    await client.waitFor(() => client.events().length === 2, "devices.updated");
    const updated = client.events().at(1);
    assert.ok(updated, "devices.updated event missing");
    assert.deepEqual(updated.payload, { reason: "device_added", deviceId: null });
    assert.match(updated.id, UUID);
    assert.ok(!client.text.includes("event:"), "no event: line (API §6)");
    assert.equal(client.types().length, 2, "no replay: Last-Event-ID is ignored");

    await closeClients(t, [client]);
  });

  test("refused before streaming: no token → 401 unauthorized, an expired token → 401 access_token_expired", async () => {
    const anonymous = await SseClient.open(t.port, null);
    await anonymous.waitForEnd();
    assert.equal(anonymous.response.statusCode, 401);
    assert.match(String(anonymous.response.headers["content-type"]), /^application\/json/);
    assert.equal((JSON.parse(anonymous.text) as { code: string }).code, "unauthorized");

    const account = await newAccount();
    const start = t.clock.now();
    t.clock.advance(TTL_MS);
    try {
      const expired = await SseClient.open(t.port, account.session.tokens.accessToken);
      await expired.waitForEnd();
      assert.equal(expired.response.statusCode, 401);
      assert.equal((JSON.parse(expired.text) as { code: string }).code, "access_token_expired");
    } finally {
      t.clock.set(start);
    }
    assert.equal(t.ctx.live.count(), 0);
  });

  test("HEAD answers the stream headers and opens nothing", async () => {
    const account = await newAccount();
    const head = await SseClient.open(t.port, account.session.tokens.accessToken, { method: "HEAD" });
    await head.waitForEnd();
    assert.equal(head.response.statusCode, 200);
    assert.equal(head.response.headers["content-type"], "text/event-stream; charset=utf-8");
    assert.equal(head.text, "");
    assert.equal(t.ctx.live.count(), 0);
  });
});

describe("GET /auth/me/events: heartbeat, expiry, limits (DESIGN §4.7)", () => {
  test("a heartbeat comment every SSE_HEARTBEAT_SECONDS; the loop stops once no stream is open", async () => {
    const account = await newAccount();
    const client = await SseClient.connect(t.port, account.session.tokens.accessToken);
    assert.ok(t.timers.delays().includes(HEARTBEAT_MS));

    t.clock.advance(HEARTBEAT_MS);
    assert.equal(t.timers.fire(HEARTBEAT_MS), 1);
    await client.waitFor(() => client.text.endsWith(`: heartbeat ${t.clock.now()}\n\n`), "the heartbeat comment");
    assert.equal(client.isEnded, false);
    assert.ok(t.timers.delays().includes(HEARTBEAT_MS), "the next beat is scheduled");
    assert.deepEqual(client.types(), ["system.connected"]);

    await closeClients(t, [client]);
    t.timers.fire(HEARTBEAT_MS);
    assert.ok(!t.timers.delays().includes(HEARTBEAT_MS), "idle: no beat is scheduled");
  });

  test("the stream closes at the exp of its token; a newer stream of the device stays (make-before-break)", async () => {
    const account = await newAccount();
    const first = await SseClient.connect(t.port, account.session.tokens.accessToken);
    const firstExpiry = t.timers.latest(TTL_MS);

    t.clock.advance(TTL_MS - 100_000);
    const renewed = await createSession(t.ctx, { userId: account.user.id, deviceId: account.device.id });
    const second = await SseClient.connect(t.port, renewed.tokens.accessToken);

    t.clock.advance(100_000);
    t.timers.fireId(firstExpiry);
    await first.waitForEnd();
    assert.deepEqual(first.types(), ["system.connected"]);
    assert.equal(second.isEnded, false);
    assert.equal(t.ctx.live.count(account.user.id), 1);

    // Safety net: past its exp, the next heartbeat closes the stream even if its timer did not fire.
    t.clock.set(renewed.accessTokenExpiresAtMs);
    t.timers.fire(HEARTBEAT_MS);
    await second.waitForEnd();
    assert.equal(t.ctx.live.count(), 0);
    assert.ok(!t.timers.delays().includes(TTL_MS), "the expiry timers are gone with their streams");
  });

  test("the fifth stream of a device evicts the first", async () => {
    const account = await newAccount();
    const clients: SseClient[] = [];
    for (let index = 0; index < 5; index++) {
      clients.push(await SseClient.connect(t.port, account.session.tokens.accessToken));
    }
    await clients[0]!.waitForEnd();
    assert.deepEqual(clients[0]!.types(), ["system.connected"]);
    for (const client of clients.slice(1)) assert.equal(client.isEnded, false);
    assert.equal(t.ctx.live.count(account.user.id), 4);
    await closeClients(t, clients);
  });

  test("a client that stops reading is dropped once more than 512 KiB wait for it", async () => {
    const account = await newAccount();
    const stuck = await SseClient.connect(t.port, account.session.tokens.accessToken);
    stuck.response.pause();
    const name = "x".repeat(64 * 1024);
    let published = 0;
    while (t.ctx.live.count(account.user.id) > 0 && published < 2000) {
      t.ctx.live.publish(account.user.id, "account.updated", {
        reason: "password_changed",
        byDevice: { id: account.device.id, name },
      });
      published += 1;
    }
    assert.equal(t.ctx.live.count(account.user.id), 0, `still open after ${published} events of 64 KiB`);
    await stuck.waitForEnd();
    assert.ok(!t.timers.delays().includes(TTL_MS));
  });

  test("a client that goes away is forgotten, with its expiry timer", async () => {
    const account = await newAccount();
    const client = await SseClient.connect(t.port, account.session.tokens.accessToken);
    const expiry = t.timers.latest(TTL_MS);
    client.destroy();
    await until(() => t.ctx.live.count() === 0, "the stream forgotten");
    assert.equal(t.timers.pending.has(expiry), false);
  });
});

describe("GET /auth/me/events: revocation (M5)", () => {
  test("a device deleted in another process gets session.invalidated{device_revoked} and closes at the next heartbeat", async () => {
    const account = await newAccount();
    const other = await secondDevice(account);
    const revoked = await SseClient.connect(t.port, account.session.tokens.accessToken);
    const kept = await SseClient.connect(t.port, other.token);

    await writeElsewhere(t.database, "DELETE FROM devices WHERE id = ?", [account.device.id]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(revoked.isEnded, false, "nothing happens before the heartbeat");

    t.clock.advance(HEARTBEAT_MS);
    t.timers.fire(HEARTBEAT_MS);
    await revoked.waitForEnd();
    assert.deepEqual(revoked.types(), ["system.connected", "session.invalidated"]);
    assert.deepEqual(revoked.events().at(-1)?.payload, { reason: "device_revoked", forceRelogin: true });
    assert.ok(revoked.text.endsWith("\n\n"), "the event frame is complete before the close");

    assert.equal(kept.isEnded, false);
    assert.deepEqual(kept.types(), ["system.connected"]);
    await closeClients(t, [kept]);
  });

  test("auth_version raised in another process closes the stream at the next heartbeat without an event", async () => {
    const account = await newAccount();
    const client = await SseClient.connect(t.port, account.session.tokens.accessToken);
    await writeElsewhere(t.database, "UPDATE users SET auth_version = auth_version + 1 WHERE id = ?", [
      account.user.id,
    ]);
    t.timers.fire(HEARTBEAT_MS);
    await client.waitForEnd();
    assert.deepEqual(client.types(), ["system.connected"]);
    assert.equal(t.ctx.live.count(), 0);
  });

  test("an account deleted in another process gets session.invalidated{account_deleted}", async () => {
    const account = await newAccount();
    const client = await SseClient.connect(t.port, account.session.tokens.accessToken);
    await writeElsewhere(t.database, "UPDATE users SET deleted_at = ? WHERE id = ?", [t.clock.now(), account.user.id]);
    t.timers.fire(HEARTBEAT_MS);
    await client.waitForEnd();
    assert.deepEqual(client.types(), ["system.connected", "session.invalidated"]);
    assert.deepEqual(client.events().at(-1)?.payload, { reason: "account_deleted", forceRelogin: true });
  });

  test("a removal in this process: session.invalidated, the close, then devices.updated to the others", async () => {
    const account = await newAccount();
    const other = await secondDevice(account);
    const revoked = await SseClient.connect(t.port, account.session.tokens.accessToken);
    const kept = await SseClient.connect(t.port, other.token);
    t.ctx.devices.afterRemove({ userId: account.user.id, deviceIds: [account.device.id], reason: "device_revoked" });
    await revoked.waitForEnd();
    assert.deepEqual(revoked.types(), ["system.connected", "session.invalidated"]);
    await kept.waitFor(() => kept.events().length === 2, "devices.updated");
    assert.deepEqual(kept.events()[1]?.payload, { reason: "device_removed", deviceId: account.device.id });
    await closeClients(t, [kept]);
  });
});

describe("GET /auth/me/events: coalescing", () => {
  test("sync.changed: the first at once, the rest merged into one trailing event after 2 s; not to the author", async () => {
    const account = await newAccount();
    const other = await secondDevice(account);
    const author = await SseClient.connect(t.port, account.session.tokens.accessToken);
    const listener = await SseClient.connect(t.port, other.token);
    const cursor = (seq: number) => `${account.user.epoch}.${seq}.${seq}`;
    for (const seq of [1, 2, 3]) {
      t.ctx.live.publishCoalesced(
        account.user.id,
        "sync.changed",
        { cursor: cursor(seq) },
        { excludeDeviceId: account.device.id },
      );
    }
    await listener.waitFor(() => listener.events().length === 2, "the leading sync.changed");
    assert.deepEqual(listener.events()[1]?.payload, { cursor: cursor(1) });
    assert.ok(t.timers.delays().includes(COALESCE_MS));

    t.timers.fire(COALESCE_MS);
    await listener.waitFor(() => listener.events().length === 3, "the trailing sync.changed");
    assert.deepEqual(listener.events()[2]?.payload, { cursor: cursor(3) });
    t.timers.fire(COALESCE_MS);
    assert.deepEqual(author.types(), ["system.connected"]);
    await closeClients(t, [author, listener]);
  });
});

describe("GET /auth/me/events: shutdown", () => {
  test("app.close() finishes while streams are open: every stream ends, no timer is left", async () => {
    const own = await createSseApp();
    try {
      const first = await createAccount(own.ctx);
      const second = await createAccount(own.ctx);
      const clients = [
        await SseClient.connect(own.port, first.session.tokens.accessToken),
        await SseClient.connect(own.port, first.session.tokens.accessToken),
        await SseClient.connect(own.port, second.session.tokens.accessToken),
      ];
      own.ctx.live.publishCoalesced(first.user.id, "sync.changed", { cursor: `${first.user.epoch}.1.1` });
      own.ctx.live.publishCoalesced(first.user.id, "sync.changed", { cursor: `${first.user.epoch}.2.2` });

      await within(own.app.close(), 5000, () => "app.close() did not finish with streams open");
      for (const client of clients) await client.waitForEnd();
      assert.equal(own.ctx.live.count(), 0);
      assert.deepEqual(own.timers.delays(), [], "heartbeat, expiry and coalescing timers are all gone");
    } finally {
      await own.close();
    }
  });
});
