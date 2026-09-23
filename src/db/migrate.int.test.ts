/**
 * Migrations and the schema check on a real database, in both dialects (PLAN M0 acceptance): migrations pass on an
 * empty database, a second run does nothing, the snapshot matches; a changed schema fails the strict check (exit code
 * 1); the "database newer than the code" wrapper; the ID collation of M10 on PostgreSQL with `en_US.UTF-8`.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { sql } from "kysely";
import { TEST_DIALECT, createMigratedTestDatabase, createTestDatabase } from "../test/test-db.ts";
import type { Db } from "./index.ts";
import { MIGRATION_TABLE, MigrationError, migrateToLatest, prepareDatabase, readMigrationState } from "./migrate.ts";
import { MIGRATIONS } from "./migrations/index.ts";
import type { MelogoldMigration } from "./migrations/index.ts";
import {
  SchemaMismatchError,
  checkSchema,
  compareSchema,
  introspectSchema,
  loadSchemaSnapshot,
} from "./schema-check.ts";

type Warning = { details: object; message: string };

function recordingLog(): { log: { warn(details: object, message: string): void }; warnings: Warning[] } {
  const warnings: Warning[] = [];
  return { log: { warn: (details, message) => warnings.push({ details, message }) }, warnings };
}

const KNOWN = MIGRATIONS.map((migration) => migration.name);

/** Runs `fn` with a fresh, empty test database and `ctx.db` on it. */
async function withEmptyDb(fn: (db: Db) => Promise<void>): Promise<void> {
  const database = await createTestDatabase();
  const db = database.openDb();
  try {
    await fn(db);
  } finally {
    await db.destroy();
    await database.cleanup();
  }
}

/** Runs `fn` with a fresh, fully migrated test database. */
async function withMigratedDb(fn: (db: Db) => Promise<void>): Promise<void> {
  const { database, db } = await createMigratedTestDatabase();
  try {
    await fn(db);
  } finally {
    await db.destroy();
    await database.cleanup();
  }
}

async function recordUnknownMigration(db: Db, name: string): Promise<void> {
  await sql`INSERT INTO ${sql.id(MIGRATION_TABLE)} (name, timestamp) VALUES (${name}, ${new Date().toISOString()})`.execute(
    db.kysely,
  );
}

describe(`migrations (${TEST_DIALECT})`, () => {
  test("an empty database gets every migration in one run; a second run does nothing", async () => {
    await withEmptyDb(async (db) => {
      const { log, warnings } = recordingLog();
      assert.deepEqual(await readMigrationState(db), { applied: [], pending: KNOWN, unknown: [] });

      const first = await migrateToLatest(db, { log });
      assert.equal(first.status, "migrated");
      assert.deepEqual(first.executed, KNOWN);
      assert.deepEqual(first.state, { applied: KNOWN, pending: [], unknown: [] });

      const second = await migrateToLatest(db, { log });
      assert.equal(second.status, "up_to_date");
      assert.deepEqual(await readMigrationState(db), { applied: KNOWN, pending: [], unknown: [] });
      assert.deepEqual(warnings, []);
    });
  });

  test("the migrated schema matches the snapshot: tables, physical types, nullability, indexes", async () => {
    await withMigratedDb(async (db) => {
      const snapshot = loadSchemaSnapshot();
      assert.deepEqual(snapshot.migrations, KNOWN, "schema.snapshot.json is stale: run npm run schema:sql");
      const live = await introspectSchema(db.kysely, db.dialect);
      assert.deepEqual(compareSchema(snapshot, live, db.dialect), { problems: [], extras: [] });

      const { log, warnings } = recordingLog();
      const result = await checkSchema(db.kysely, db.dialect, { mode: "strict", log });
      assert.deepEqual(result, { ok: true, problems: [], extras: [] });
      assert.deepEqual(warnings, []);

      // Spot checks of what the comparison relies on.
      const login = live.tables.get("users")?.columns.find((column) => column.name === "login");
      assert.equal(login?.physical, TEST_DIALECT === "postgres" ? 'text COLLATE "C"' : "TEXT");
      const title = live.tables.get("sync_tracks")?.columns.find((column) => column.name === "title");
      assert.equal(title?.physical, TEST_DIALECT === "postgres" ? "text" : "TEXT");
      if (TEST_DIALECT === "sqlite") {
        assert.ok(
          [...live.tables.values()].every((table) => table.name.startsWith("kysely_") || table.strict === true),
          "every SQLite table is STRICT",
        );
      }
    });
  });

  test("a failing migration rolls the whole run back", async () => {
    await withEmptyDb(async (db) => {
      const failing: MelogoldMigration[] = [
        ...MIGRATIONS.slice(0, 2),
        {
          name: "0003_broken",
          up: async (kysely) => {
            await sql`CREATE TABLE half_done (id INTEGER NOT NULL PRIMARY KEY)`.execute(kysely);
            throw new Error("boom");
          },
        },
      ];
      await assert.rejects(migrateToLatest(db, { log: recordingLog().log, migrations: failing }), (error) => {
        assert.ok(error instanceof MigrationError);
        assert.match(error.message, /migration 0003_broken failed/);
        assert.equal(error.exitCode, 1);
        return true;
      });
      const live = await introspectSchema(db.kysely, db.dialect);
      const tables = [...live.tables.keys()].filter((name) => !name.startsWith("kysely_"));
      assert.deepEqual(tables, [], "no table of 0001, 0002 or the broken migration survives");
      assert.deepEqual((await readMigrationState(db, failing)).applied, []);

      // The same database migrates cleanly afterwards.
      assert.equal((await migrateToLatest(db, { log: recordingLog().log })).status, "migrated");
    });
  });

  test("migrations run in order: a later run applies only the new ones", async () => {
    await withEmptyDb(async (db) => {
      const { log } = recordingLog();
      const early = await migrateToLatest(db, { log, migrations: MIGRATIONS.slice(0, 2) });
      assert.equal(early.status, "migrated");
      assert.deepEqual(early.executed, KNOWN.slice(0, 2));
      const late = await migrateToLatest(db, { log });
      assert.equal(late.status, "migrated");
      assert.deepEqual(late.executed, KNOWN.slice(2));
      const result = await checkSchema(db.kysely, db.dialect, { mode: "strict", log });
      assert.equal(result.ok, true);
    });
  });

  test("migrations refuse to run inside db.read/db.write", async () => {
    await withEmptyDb(async (db) => {
      await assert.rejects(
        db.write(() => migrateToLatest(db, { log: recordingLog().log })),
        /db\.migrate called inside db\.write/,
      );
    });
  });
});

describe(`schema check (${TEST_DIALECT})`, () => {
  test("a changed schema fails the strict check (exit code 1) and only warns under SCHEMA_CHECK=warn", async () => {
    await withMigratedDb(async (db) => {
      await sql`ALTER TABLE devices ADD COLUMN nickname TEXT NULL`.execute(db.kysely);
      await sql`DROP INDEX devices_last_seen`.execute(db.kysely);

      await assert.rejects(checkSchema(db.kysely, db.dialect, { mode: "strict", log: recordingLog().log }), (error) => {
        assert.ok(error instanceof SchemaMismatchError);
        assert.equal(error.exitCode, 1);
        assert.deepEqual(error.problems, [
          "index devices_last_seen is missing",
          "column devices.nickname is not in the snapshot",
        ]);
        return true;
      });

      const { log, warnings } = recordingLog();
      const result = await checkSchema(db.kysely, db.dialect, { mode: "warn", log });
      assert.equal(result.ok, false);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]?.message ?? "", /SCHEMA_CHECK=warn/);
    });
  });

  test("a missing table, a different type and a different nullability are problems", async () => {
    await withMigratedDb(async (db) => {
      await sql`DROP TABLE play_forgets`.execute(db.kysely);
      await sql`DROP TABLE play_stats`.execute(db.kysely);
      // Same name and columns, but the wrong type and nullability.
      await sql`CREATE TABLE play_stats (user_id TEXT NULL, video_id TEXT NOT NULL, total_ms TEXT NOT NULL,
                last_played_at BIGINT NULL, seq BIGINT NOT NULL, PRIMARY KEY (video_id))`.execute(db.kysely);
      const diff = compareSchema(loadSchemaSnapshot(), await introspectSchema(db.kysely, db.dialect), db.dialect);
      const expected =
        TEST_DIALECT === "postgres"
          ? [
              'column play_stats.user_id has type text, expected text COLLATE "C" (ID)',
              "column play_stats.user_id is NULL, expected the opposite",
              'column play_stats.video_id has type text, expected text COLLATE "C" (ID)',
              "column play_stats.total_ms has type text, expected bigint (BIG)",
              "index play_stats_pull is missing",
              "table play_forgets is missing",
            ]
          : [
              "table play_stats is not STRICT",
              "column play_stats.user_id is NULL, expected the opposite",
              "column play_stats.total_ms has type TEXT, expected INTEGER (BIG)",
              "column play_stats.last_played_at has type BIGINT, expected INTEGER (TS)",
              "column play_stats.seq has type BIGINT, expected INTEGER (BIG)",
              "index play_stats_pull is missing",
              "table play_forgets is missing",
            ];
      assert.deepEqual(diff.problems, expected);
      assert.deepEqual(diff.extras, []);
    });
  });

  test("database newer than the code: a warning, no migrations, unknown columns tolerated", async () => {
    await withMigratedDb(async (db) => {
      await recordUnknownMigration(db, "0006_future");
      await sql`ALTER TABLE devices ADD COLUMN future_flag INTEGER NULL`.execute(db.kysely);

      const { log, warnings } = recordingLog();
      const result = await prepareDatabase(db, { log, migrateOnStart: true, schemaCheck: "strict" });
      assert.equal(result.migration.status, "schema_newer");
      assert.deepEqual(result.migration.state, {
        applied: [...KNOWN, "0006_future"],
        pending: [],
        unknown: ["0006_future"],
      });
      assert.deepEqual(result.schema, {
        ok: true,
        problems: [],
        extras: ["column devices.future_flag is not in the snapshot"],
      });
      assert.deepEqual(
        warnings.map((warning) => warning.message),
        [
          "the database schema is newer than this version (image rolled back?): migrations are skipped",
          "the database has tables or columns this version does not know",
        ],
      );
    });
  });

  test("unknown applied migrations while known ones are pending: another branch of the code, refused", async () => {
    await withEmptyDb(async (db) => {
      const { log } = recordingLog();
      await migrateToLatest(db, { log, migrations: MIGRATIONS.slice(0, 2) });
      await recordUnknownMigration(db, "0002_other_branch");
      await assert.rejects(migrateToLatest(db, { log }), (error) => {
        assert.ok(error instanceof MigrationError);
        assert.match(error.message, /does not know \(0002_other_branch\) and lacks migrations it knows \(0003_sync/);
        return true;
      });
    });
  });

  test("MIGRATE_ON_START=false: pending migrations stop the start, an up-to-date database starts", async () => {
    await withEmptyDb(async (db) => {
      const { log } = recordingLog();
      const options = { log, migrateOnStart: false, schemaCheck: "strict" } as const;
      await assert.rejects(prepareDatabase(db, options), (error) => {
        assert.ok(error instanceof MigrationError);
        assert.equal(error.exitCode, 1);
        assert.match(error.message, /MIGRATE_ON_START=false and migrations are pending \(0001_core/);
        return true;
      });
      assert.deepEqual((await readMigrationState(db)).applied, [], "nothing was migrated");

      const started = await prepareDatabase(db, { ...options, migrateOnStart: true });
      assert.equal(started.migration.status, "migrated");
      const again = await prepareDatabase(db, options);
      assert.equal(again.migration.status, "up_to_date");
      assert.equal(again.schema.ok, true);
    });
  });
});

describe(`ID collation (${TEST_DIALECT}, M10)`, () => {
  test("sync_playlist_items joins sync_tracks by video_id and orders by sort_key byte-wise", async () => {
    await withMigratedDb(async (db) => {
      const now = 1_700_000_000_000;
      const video = (suffix: string) => `vid_${suffix}`.padEnd(11, "x");
      await db.write(async (q) => {
        await q
          .insertInto("users")
          .values({
            id: "u1",
            login: "alice",
            password_hash: "$argon2id$stub",
            password_changed_at: now,
            recovery_code_hash: "0".repeat(64),
            recovery_code_created_at: now,
            created_at: now,
            updated_at: now,
          })
          .execute();
        await q
          .insertInto("sync_playlists")
          .values({ user_id: "u1", id: "p1", name: "Mix", created_at: now, seq: 1, clk_at: now })
          .execute();
        const items = [
          { key: "a", suffix: "1" },
          { key: "B", suffix: "2" },
          { key: "_", suffix: "3" },
          { key: "Z0", suffix: "4" },
        ];
        await q
          .insertInto("sync_playlist_items")
          .values(
            items.map(({ key, suffix }, index) => ({
              user_id: "u1",
              playlist_id: "p1",
              video_id: video(suffix),
              present: 1 as const,
              sort_key: key,
              added_at: now,
              seq: 2 + index,
              mem_seq: 2 + index,
              mem_at: now,
              pos_seq: 2 + index,
              pos_at: now,
            })),
          )
          .execute();
        await q
          .insertInto("sync_tracks")
          .values(
            items.map(({ suffix }, index) => ({
              user_id: "u1",
              video_id: video(suffix),
              title: `T${suffix}`,
              seq: 10 + index,
              updated_at: now,
            })),
          )
          .execute();
      });

      const rows = await db.read((q) =>
        q
          .selectFrom("sync_playlist_items as i")
          .innerJoin("sync_tracks as t", (join) =>
            join.onRef("t.user_id", "=", "i.user_id").onRef("t.video_id", "=", "i.video_id"),
          )
          .select(["i.sort_key", "t.title"])
          .where("i.user_id", "=", "u1")
          .where("i.playlist_id", "=", "p1")
          .where("i.present", "=", 1)
          .orderBy("i.sort_key")
          .orderBy("i.video_id")
          .execute(),
      );
      // Byte order: "B" (0x42) < "Z0" (0x5A) < "_" (0x5F) < "a" (0x61); en_US.UTF-8 would give _ a B Z0.
      assert.deepEqual(
        rows.map((row) => row.sort_key),
        ["B", "Z0", "_", "a"],
      );
      assert.deepEqual(
        rows.map((row) => row.title),
        ["T2", "T4", "T3", "T1"],
      );
    });
  });
});
