/**
 * `sync_heads` helpers on the migrated schema, in both dialects: the user mutex (`lockUser` first, serialization of
 * concurrent writers), the missing-head retry through `ensureHead` (API §9.5, m7), and ON CONFLICT inside `db.write`
 * on the real tables (M11).
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Kysely } from "kysely";
import { TEST_DIALECT, createMigratedTestDatabase } from "../test/test-db.ts";
import type { TestDatabase } from "../test/test-db.ts";
import { EPOCH_PATTERN, bumpHead, ensureHead, insertHead, lockUser, newEpoch, readHead } from "./heads.ts";
import type { Database, Db } from "./index.ts";
import { MissingHeadError, TxRuleError } from "./tx.ts";

const NOW = 1_700_000_000_000;

let database: TestDatabase;
let db: Db;

before(async () => {
  ({ database, db } = await createMigratedTestDatabase({ db: { now: () => NOW } }));
});

after(async () => {
  await db.destroy();
  await database.cleanup();
});

async function insertUser(q: Kysely<Database>, id: string): Promise<void> {
  await q
    .insertInto("users")
    .values({
      id,
      login: `login-${id}`,
      password_hash: "$argon2id$stub",
      password_changed_at: NOW,
      recovery_code_hash: "0".repeat(64),
      recovery_code_created_at: NOW,
      created_at: NOW,
      updated_at: NOW,
    })
    .execute();
}

async function createUser(id: string, withHead = true): Promise<void> {
  await db.write(async (q) => {
    await insertUser(q, id);
    if (withHead) await insertHead(q, id, NOW);
  });
}

describe(`sync_heads (${TEST_DIALECT})`, () => {
  test("newEpoch: 8 lowercase hex characters", () => {
    for (let i = 0; i < 100; i++) assert.match(newEpoch(), EPOCH_PATTERN);
  });

  test("insertHead with the user; lockUser in db.write and readHead in db.read return it", async () => {
    await createUser("u-basic");
    const locked = await db.write((q) => lockUser(q, "u-basic"));
    assert.equal(locked.userId, "u-basic");
    assert.match(locked.epoch, EPOCH_PATTERN);
    assert.deepEqual(
      { seq: locked.seq, floorSeq: locked.floorSeq, updatedAt: locked.updatedAt },
      {
        seq: 0,
        floorSeq: 0,
        updatedAt: NOW,
      },
    );
    assert.deepEqual(await db.read((q) => readHead(q, "u-basic")), locked);
  });

  test("lockUser must be the first statement of db.write", async () => {
    await createUser("u-first");
    await assert.rejects(
      db.write(async (q) => {
        await q.selectFrom("users").select("id").where("id", "=", "u-first").execute();
        return lockUser(q, "u-first");
      }),
      (error) => error instanceof TxRuleError && error.message.includes("first statement"),
    );
    await assert.rejects(
      db.read((q) => lockUser(q, "u-first")),
      (error) => error instanceof TxRuleError && error.message.includes("inside db.write"),
    );
  });

  test("a missing head is created by ensureHead and the callback runs again (m7)", async () => {
    await createUser("u-headless", false);
    let attempts = 0;
    const head = await db.write(async (q) => {
      attempts += 1;
      return lockUser(q, "u-headless");
    });
    assert.equal(attempts, 2);
    assert.equal(head.seq, 0);
    assert.equal(head.updatedAt, NOW);
    assert.match(head.epoch, EPOCH_PATTERN);

    await createUser("u-headless-read", false);
    assert.equal((await db.read((q) => readHead(q, "u-headless-read"))).seq, 0);
  });

  test("an unknown user: ensureHead returns false and MissingHeadError reaches the caller", async () => {
    assert.equal(await ensureHead(db, "u-ghost", NOW), false);
    await assert.rejects(
      db.write((q) => lockUser(q, "u-ghost")),
      (error) => error instanceof MissingHeadError && error.userId === "u-ghost",
    );
    assert.equal(
      await db.read((q) =>
        q.selectFrom("sync_heads").select("user_id").where("user_id", "=", "u-ghost").executeTakeFirst(),
      ),
      undefined,
    );
  });

  test("ensureHead keeps an existing head (ON CONFLICT DO NOTHING)", async () => {
    await createUser("u-keep");
    const before = await db.write(async (q) => {
      const head = await lockUser(q, "u-keep");
      await bumpHead(q, "u-keep", head.seq + 5, NOW + 1);
      return head;
    });
    assert.equal(await ensureHead(db, "u-keep", NOW + 2), true);
    const afterEnsure = await db.read((q) => readHead(q, "u-keep"));
    assert.deepEqual(afterEnsure, { ...before, seq: 5, updatedAt: NOW + 1 });
  });

  test("bumpHead only moves forward and only inside db.write", async () => {
    await createUser("u-bump");
    await db.write(async (q) => {
      await lockUser(q, "u-bump");
      await bumpHead(q, "u-bump", 3, NOW);
    });
    await assert.rejects(
      db.write(async (q) => {
        await lockUser(q, "u-bump");
        await bumpHead(q, "u-bump", 2, NOW);
      }),
      (error) => error instanceof TxRuleError && error.message.includes("beyond seq 2"),
    );
    await assert.rejects(
      db.run((q) => bumpHead(q, "u-bump", 9, NOW)),
      TxRuleError,
    );
    assert.equal((await db.read((q) => readHead(q, "u-bump"))).seq, 3);
  });

  test("lockUser serializes writers of one user: concurrent read-modify-write of seq loses nothing", async () => {
    await createUser("u-race");
    // PostgreSQL: a second pool, so the writers really run in parallel and FOR UPDATE does the work. SQLite: the one
    // connection of the process (a second one would block the event loop in busy_timeout, see docs/database.md);
    // writers from other processes are covered in tx.int.test.ts.
    const other = TEST_DIALECT === "postgres" ? database.openDb({ now: () => NOW }) : db;
    const increment = (handle: Db) =>
      handle.write(async (q) => {
        const head = await lockUser(q, "u-race");
        await new Promise((resolve) => setTimeout(resolve, 2));
        await bumpHead(q, "u-race", head.seq + 1, NOW);
        return head.seq + 1;
      });
    try {
      const seqs = await Promise.all(Array.from({ length: 20 }, (_, index) => increment(index % 2 === 0 ? db : other)));
      assert.deepEqual(
        [...seqs].sort((a, b) => a - b),
        Array.from({ length: 20 }, (_, index) => index + 1),
      );
    } finally {
      if (other !== db) await other.destroy();
    }
    assert.equal((await db.read((q) => readHead(q, "u-race"))).seq, 20);
  });

  test("a unique conflict handled by ON CONFLICT inside db.write does not break the transaction (M11)", async () => {
    await createUser("u-taken");
    const outcome = await db.write(async (q) => {
      const inserted = await q
        .insertInto("users")
        .values({
          id: "u-second",
          login: "login-u-taken",
          password_hash: "$argon2id$stub",
          password_changed_at: NOW,
          recovery_code_hash: "1".repeat(64),
          recovery_code_created_at: NOW,
          created_at: NOW,
          updated_at: NOW,
        })
        .onConflict((conflict) => conflict.column("login").doNothing())
        .returning("id")
        .executeTakeFirst();
      // The transaction is still usable in both dialects (PostgreSQL would be in 25P02 after a caught error).
      await q
        .updateTable("users")
        .set({ updated_at: NOW + 1 })
        .where("id", "=", "u-taken")
        .execute();
      return inserted;
    });
    assert.equal(outcome, undefined);
    const row = await db.read((q) =>
      q.selectFrom("users").select(["id", "updated_at"]).where("login", "=", "login-u-taken").executeTakeFirstOrThrow(),
    );
    assert.deepEqual(row, { id: "u-taken", updated_at: NOW + 1 });
  });

  test("deleting a user removes its head (ON DELETE CASCADE)", async () => {
    await createUser("u-cascade");
    await db.write((q) => q.deleteFrom("users").where("id", "=", "u-cascade").execute());
    const head = await db.read((q) =>
      q.selectFrom("sync_heads").select("user_id").where("user_id", "=", "u-cascade").executeTakeFirst(),
    );
    assert.equal(head, undefined);
  });
});

describe("PostgreSQL introspection", { skip: TEST_DIALECT !== "postgres" }, () => {
  test("db.introspection sees only the current schema", async () => {
    const tables = await db.kysely.introspection.getTables({ withInternalKyselyTables: true });
    assert.ok(tables.length > 0);
    assert.deepEqual([...new Set(tables.map((table) => table.schema))], [database.searchPath]);
    assert.ok(tables.some((table) => table.name === "kysely_migration"));
    const users = tables.find((table) => table.name === "users");
    assert.equal(users?.columns.find((column) => column.name === "recovery_code_confirmed_at")?.isNullable, true);
  });
});
