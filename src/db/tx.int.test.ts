import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { after, before, beforeEach, describe, test } from "node:test";
import { sql } from "kysely";
import type { Kysely } from "kysely";
import { TEST_DIALECT, createTestDatabase } from "../test/test-db.ts";
import type { TestDatabase } from "../test/test-db.ts";
import { ddl } from "./ddl.ts";
import { constraintViolation } from "./errors.ts";
import {
  MissingHeadError,
  NestedDbAccessError,
  TxRuleError,
  assertFirstStatementOfWrite,
  createTxRunner,
  withSavepoint,
} from "./tx.ts";
import type { TxRunner } from "./tx.ts";

type Schema = {
  items: { id: string; value: number };
};

const execFileAsync = promisify(execFile);

/** Increments `items.shared` `times` times from a separate Node process, each in its own BEGIN IMMEDIATE. */
async function runSqliteIncrements(file: string, times: number): Promise<void> {
  const script = `
    import Database from "better-sqlite3";
    const db = new Database(process.argv[1], { timeout: 10000 });
    const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    for (let i = 0; i < Number(process.argv[2]); i++) {
      db.exec("BEGIN IMMEDIATE");
      const { value } = db.prepare("SELECT value FROM items WHERE id = 'shared'").get();
      pause(2);
      db.prepare("UPDATE items SET value = ? WHERE id = 'shared'").run(value + 1);
      db.exec("COMMIT");
      pause(1);
    }
    db.close();
  `;
  await execFileAsync(process.execPath, ["--input-type=module", "-e", script, file, String(times)], {
    cwd: new URL("../..", import.meta.url),
  });
}

let database: TestDatabase;
let kysely: Kysely<Schema>;
let tx: TxRunner<Schema>;

before(async () => {
  database = await createTestDatabase();
  const opened = database.openKysely<Schema>();
  kysely = opened.kysely;
  tx = createTxRunner(kysely);
  const d = ddl(opened.dialect);
  await d.run(
    kysely,
    d.createTable("items", { id: d.types.ID.notNull().primaryKey(), value: d.types.BIG.notNull().default(0) }),
  );
});

after(async () => {
  await kysely.destroy();
  await database.cleanup();
});

beforeEach(async () => {
  await tx.write((q) => q.deleteFrom("items").execute());
});

async function valueOf(id: string): Promise<number | undefined> {
  const row = await tx.read((q) => q.selectFrom("items").select("value").where("id", "=", id).executeTakeFirst());
  return row?.value;
}

describe(`transactions (${TEST_DIALECT})`, () => {
  test("write commits, read sees the committed row", async () => {
    await tx.write((q) => q.insertInto("items").values({ id: "a", value: 1 }).execute());
    assert.equal(await valueOf("a"), 1);
  });

  test("an error inside write rolls everything back", async () => {
    await assert.rejects(
      tx.write(async (q) => {
        await q.insertInto("items").values({ id: "a", value: 1 }).execute();
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.equal(await valueOf("a"), undefined);
  });

  test("read is read-only in both dialects, and writes work again afterwards", async () => {
    const readOnlyCode = database.dialect === "postgres" ? "25006" : "SQLITE_READONLY";
    await assert.rejects(
      tx.read((q) => q.insertInto("items").values({ id: "r", value: 1 }).execute()),
      (error: unknown) => (error as { code?: string }).code === readOnlyCode,
    );
    await tx.write((q) => q.insertInto("items").values({ id: "w", value: 2 }).execute());
    assert.equal(await valueOf("w"), 2);
    assert.equal(await valueOf("r"), undefined);
  });

  test("run executes a single statement outside a transaction", async () => {
    await tx.run((q) => q.insertInto("items").values({ id: "s", value: 3 }).execute());
    assert.equal(await valueOf("s"), 3);
  });

  test("nested read/write/run throw instead of deadlocking, the outer call rolls back", async () => {
    const combinations: [string, () => Promise<unknown>][] = [
      ["write in write", () => tx.write(() => tx.write(() => Promise.resolve()))],
      ["read in write", () => tx.write(() => tx.read(() => Promise.resolve()))],
      ["run in write", () => tx.write(() => tx.run(() => Promise.resolve()))],
      ["write in read", () => tx.read(() => tx.write(() => Promise.resolve()))],
      ["read in read", () => tx.read(() => tx.read(() => Promise.resolve()))],
      ["write in run", () => tx.run(() => tx.write(() => Promise.resolve()))],
      ["read in run", () => tx.run(() => tx.read(() => Promise.resolve()))],
    ];
    for (const [name, call] of combinations) {
      await assert.rejects(call(), NestedDbAccessError, name);
    }
    await assert.rejects(
      tx.write(async (q) => {
        await q.insertInto("items").values({ id: "outer", value: 1 }).execute();
        // Deep inside a service: the check follows the async context, not the call stack.
        await Promise.resolve().then(() => tx.write(() => Promise.resolve()));
      }),
      NestedDbAccessError,
    );
    assert.equal(await valueOf("outer"), undefined);
  });

  test("after the call ends its scope is closed: a timer created inside a committed write can use the database", async () => {
    // While the transaction is open, a timer created inside it is still nested.
    await tx.write(async () => {
      const inside = await new Promise<unknown>((resolve) => {
        setTimeout(() => {
          tx.write(() => Promise.resolve()).then(resolve, resolve);
        }, 5);
      });
      assert.ok(inside instanceof NestedDbAccessError);
    });
    // Once it has committed, the same kind of timer is not.
    const later = Promise.withResolvers<unknown>();
    await tx.write(async (q) => {
      await q.insertInto("items").values({ id: "t", value: 1 }).execute();
      setTimeout(() => {
        tx.write((inner) => inner.updateTable("items").set({ value: 2 }).where("id", "=", "t").execute()).then(
          later.resolve,
          later.reject,
        );
      }, 30);
    });
    await later.promise;
    assert.equal(await valueOf("t"), 2);
    // The same after a read, for run.
    const fromRead = Promise.withResolvers<unknown>();
    await tx.read(() => {
      setTimeout(() => {
        tx.run((q) => q.selectFrom("items").select("id").execute()).then(fromRead.resolve, fromRead.reject);
      }, 10);
      return Promise.resolve();
    });
    assert.deepEqual(await fromRead.promise, [{ id: "t" }]);
  });

  test("ON CONFLICT inside write does not break the transaction", async () => {
    await tx.write((q) => q.insertInto("items").values({ id: "dup", value: 1 }).execute());
    const inserted = await tx.write(async (q) => {
      const skipped = await q
        .insertInto("items")
        .values({ id: "dup", value: 2 })
        .onConflict((oc) => oc.column("id").doNothing())
        .returning("id")
        .execute();
      await q.insertInto("items").values({ id: "next", value: 3 }).execute();
      await q
        .insertInto("items")
        .values({ id: "dup", value: 5 })
        .onConflict((oc) => oc.column("id").doUpdateSet((eb) => ({ value: eb.ref("excluded.value") })))
        .execute();
      return skipped.length;
    });
    assert.equal(inserted, 0);
    assert.equal(await valueOf("dup"), 5);
    assert.equal(await valueOf("next"), 3);
  });

  test("a constraint error caught inside the transaction: PostgreSQL aborts it (25P02), SQLite does not", async () => {
    await tx.write((q) => q.insertInto("items").values({ id: "dup", value: 1 }).execute());
    const outcome = tx.write(async (q) => {
      try {
        await q.insertInto("items").values({ id: "dup", value: 2 }).execute();
      } catch (error) {
        assert.equal(constraintViolation(error)?.kind, "unique");
      }
      await q.insertInto("items").values({ id: "after", value: 3 }).execute();
    });
    if (database.dialect === "postgres") {
      await assert.rejects(outcome, (error: unknown) => (error as { code?: string }).code === "25P02");
      assert.equal(await valueOf("after"), undefined);
    } else {
      await outcome;
      assert.equal(await valueOf("after"), 3);
    }
  });

  test("withSavepoint keeps the transaction usable after a failed statement in both dialects", async () => {
    await tx.write((q) => q.insertInto("items").values({ id: "dup", value: 1 }).execute());
    await tx.write(async (q) => {
      await q.insertInto("items").values({ id: "before", value: 1 }).execute();
      await assert.rejects(
        withSavepoint(q, async () => {
          await q.insertInto("items").values({ id: "inside", value: 1 }).execute();
          await q.insertInto("items").values({ id: "dup", value: 2 }).execute();
        }),
        (error: unknown) => constraintViolation(error)?.kind === "unique",
      );
      const kept = await withSavepoint(q, () => q.insertInto("items").values({ id: "kept", value: 4 }).execute());
      assert.equal(kept.length, 1);
      await q.insertInto("items").values({ id: "after", value: 1 }).execute();
    });
    assert.equal(await valueOf("before"), 1);
    assert.equal(await valueOf("inside"), undefined);
    assert.equal(await valueOf("kept"), 4);
    assert.equal(await valueOf("after"), 1);
    await assert.rejects(
      tx.read((q) => withSavepoint(q, () => Promise.resolve())),
      TxRuleError,
    );
  });

  test("assertFirstStatementOfWrite: only as the first statement of db.write", async () => {
    await tx.write(() => {
      assertFirstStatementOfWrite("lockUser");
      return Promise.resolve();
    });
    await assert.rejects(
      tx.write(async (q) => {
        await q.selectFrom("items").select("id").execute();
        assertFirstStatementOfWrite("lockUser");
      }),
      TxRuleError,
    );
    await assert.rejects(
      tx.read(() => {
        assertFirstStatementOfWrite("lockUser");
        return Promise.resolve();
      }),
      TxRuleError,
    );
    assert.throws(() => {
      assertFirstStatementOfWrite("lockUser");
    }, TxRuleError);
  });

  test("FOR UPDATE works in both dialects (stripped on SQLite)", async () => {
    await tx.write((q) => q.insertInto("items").values({ id: "lock", value: 7 }).execute());
    const row = await tx.write((q) =>
      q.selectFrom("items").selectAll().where("id", "=", "lock").forUpdate().executeTakeFirstOrThrow(),
    );
    assert.equal(row.value, 7);
  });

  test("concurrent read-modify-write under FOR UPDATE loses no update (same pool)", async () => {
    await tx.write((q) => q.insertInto("items").values({ id: "counter", value: 0 }).execute());
    const increment = () =>
      tx.write(async (q) => {
        const row = await q
          .selectFrom("items")
          .select("value")
          .where("id", "=", "counter")
          .forUpdate()
          .executeTakeFirstOrThrow();
        await q
          .updateTable("items")
          .set({ value: row.value + 1 })
          .where("id", "=", "counter")
          .execute();
      });
    await Promise.all(Array.from({ length: 20 }, increment));
    assert.equal(await valueOf("counter"), 20);
  });

  test("another process writing concurrently loses no update", async () => {
    await tx.write((q) => q.insertInto("items").values({ id: "shared", value: 0 }).execute());
    const incrementHere = () =>
      tx.write(async (q) => {
        const row = await q
          .selectFrom("items")
          .select("value")
          .where("id", "=", "shared")
          .forUpdate()
          .executeTakeFirstOrThrow();
        await new Promise((resolve) => setTimeout(resolve, 1));
        await q
          .updateTable("items")
          .set({ value: row.value + 1 })
          .where("id", "=", "shared")
          .execute();
      });

    let elsewhere: Promise<unknown>;
    let closeOther = () => Promise.resolve();
    if (database.dialect === "sqlite") {
      // A real second process: in-process connections would block each other's event loop in busy_timeout.
      elsewhere = runSqliteIncrements(database.location, 10);
    } else {
      const other = database.openKysely<Schema>();
      closeOther = () => other.kysely.destroy();
      const otherTx = createTxRunner(other.kysely);
      elsewhere = Promise.all(
        Array.from({ length: 10 }, () =>
          otherTx.write(async (q) => {
            const row = await q
              .selectFrom("items")
              .select("value")
              .where("id", "=", "shared")
              .forUpdate()
              .executeTakeFirstOrThrow();
            await q
              .updateTable("items")
              .set({ value: row.value + 1 })
              .where("id", "=", "shared")
              .execute();
          }),
        ),
      );
    }
    try {
      await Promise.all([elsewhere, ...Array.from({ length: 10 }, incrementHere)]);
    } finally {
      await closeOther();
    }
    assert.equal(await valueOf("shared"), 20);
  });

  test("MissingHeadError: the runner calls ensureHead and retries once", async () => {
    const calls: string[] = [];
    const runner = createTxRunner(kysely, {
      ensureHead: async (userId) => {
        calls.push(userId);
        if (userId === "ghost") return false;
        await runner.write((q) => q.insertInto("items").values({ id: userId, value: 0 }).execute());
        return true;
      },
    });
    const lockItem = (id: string) =>
      runner.write(async (q) => {
        const row = await q.selectFrom("items").selectAll().where("id", "=", id).forUpdate().executeTakeFirst();
        if (!row) throw new MissingHeadError(id);
        return row.value;
      });
    assert.equal(await lockItem("head"), 0);
    assert.deepEqual(calls, ["head"]);
    await assert.rejects(lockItem("ghost"), MissingHeadError);
    assert.deepEqual(calls, ["head", "ghost"]);
    const readItem = (id: string) =>
      runner.read(async (q) => {
        const row = await q.selectFrom("items").selectAll().where("id", "=", id).executeTakeFirst();
        if (!row) throw new MissingHeadError(id);
        return row.value;
      });
    assert.equal(await readItem("read-head"), 0);
    assert.deepEqual(calls, ["head", "ghost", "read-head"]);
  });

  test("slow transactions are logged", async () => {
    const warnings: object[] = [];
    const runner = createTxRunner(kysely, { slowMs: -1, log: { warn: (details) => warnings.push(details) } });
    await runner.write((q) => sql`SELECT 1`.execute(q));
    assert.equal(warnings.length, 1);
    assert.equal((warnings[0] as { kind: string }).kind, "write");
  });
});
