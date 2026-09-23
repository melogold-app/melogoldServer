import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DdlError, assertPortableExpression, ddl, physicalType, recordingKysely } from "./ddl.ts";

describe("ddl: rendering (API §9.1, §9.3)", () => {
  test("logical types map to the physical types of both dialects", () => {
    assert.equal(physicalType("postgres", "ID"), 'text COLLATE "C"');
    assert.equal(physicalType("postgres", "TXT"), "text");
    assert.equal(physicalType("postgres", "INT"), "integer");
    assert.equal(physicalType("postgres", "BIG"), "bigint");
    assert.equal(physicalType("postgres", "TS"), "bigint");
    assert.equal(physicalType("postgres", "BOOL"), "integer");
    assert.equal(physicalType("postgres", "JSON"), "text");
    for (const type of ["ID", "TXT", "JSON"] as const) assert.equal(physicalType("sqlite", type), "TEXT");
    for (const type of ["INT", "BIG", "TS", "BOOL"] as const) assert.equal(physicalType("sqlite", type), "INTEGER");
  });

  test("the example table of API §9.3 renders the same in both dialects", () => {
    for (const dialect of ["postgres", "sqlite"] as const) {
      const d = ddl(dialect);
      const { ID, BOOL, TS, BIG } = d.types;
      const text = d.render(
        d.createTable(
          "sync_playlist_items",
          {
            user_id: ID.notNull(),
            playlist_id: ID.notNull(),
            video_id: ID.notNull().check("length(video_id) = 11"),
            present: BOOL.notNull(),
            sort_key: ID.notNull().check("length(sort_key) BETWEEN 1 AND 64"),
            added_at: TS.notNull(),
            seq: BIG.notNull(),
            mem_dev: ID.nullable(),
          },
          {
            primaryKey: ["user_id", "playlist_id", "video_id"],
            foreignKeys: [
              {
                columns: ["user_id", "playlist_id"],
                table: "sync_playlists",
                references: ["user_id", "id"],
                onDelete: "CASCADE",
              },
            ],
          },
        ),
      );
      const id = dialect === "postgres" ? 'text COLLATE "C"' : "TEXT";
      const integer = dialect === "postgres" ? "integer" : "INTEGER";
      const bigint = dialect === "postgres" ? "bigint" : "INTEGER";
      assert.equal(
        text,
        [
          "CREATE TABLE sync_playlist_items (",
          `  user_id     ${id} NOT NULL,`,
          `  playlist_id ${id} NOT NULL,`,
          `  video_id    ${id} NOT NULL CHECK (length(video_id) = 11),`,
          `  present     ${integer} NOT NULL CHECK (present IN (0,1)),`,
          `  sort_key    ${id} NOT NULL CHECK (length(sort_key) BETWEEN 1 AND 64),`,
          `  added_at    ${bigint} NOT NULL,`,
          `  seq         ${bigint} NOT NULL,`,
          `  mem_dev     ${id} NULL,`,
          "  PRIMARY KEY (user_id, playlist_id, video_id),",
          "  FOREIGN KEY (user_id, playlist_id) REFERENCES sync_playlists (user_id, id) ON DELETE CASCADE",
          `)${dialect === "sqlite" ? " STRICT" : ""}`,
        ].join("\n"),
      );
    }
  });

  test("column clauses: PRIMARY KEY, UNIQUE, DEFAULT, REFERENCES, CHECK in a fixed order", () => {
    const d = ddl("postgres");
    const { ID, TXT, INT } = d.types;
    const text = d.render(
      d.createTable("users", {
        id: ID.notNull().primaryKey(),
        login: ID.notNull().unique().check("length(login) BETWEEN 3 AND 64"),
        created_by: TXT.notNull().default("self"),
        auth_version: INT.notNull().default(1),
        owner_id: ID.nullable().references("users", "id", "SET NULL"),
      }),
    );
    assert.match(text, /id +text COLLATE "C" NOT NULL PRIMARY KEY,/);
    assert.match(text, /login +text COLLATE "C" NOT NULL UNIQUE CHECK \(length\(login\) BETWEEN 3 AND 64\),/);
    assert.match(text, /created_by +text NOT NULL DEFAULT 'self',/);
    assert.match(text, /auth_version +integer NOT NULL DEFAULT 1,/);
    assert.match(text, /owner_id +text COLLATE "C" NULL REFERENCES users\(id\) ON DELETE SET NULL\n/);
  });

  test("indexes, partial indexes and ADD COLUMN", () => {
    const d = ddl("sqlite");
    assert.equal(
      d.render(d.createIndex("users_deleted", "users", ["deleted_at"], { where: "deleted_at IS NOT NULL" })),
      "CREATE INDEX users_deleted ON users (deleted_at) WHERE deleted_at IS NOT NULL",
    );
    assert.equal(
      d.render(d.createIndex("sync_ops_op", "sync_ops", ["user_id", "op_id"], { unique: true })),
      "CREATE UNIQUE INDEX sync_ops_op ON sync_ops (user_id, op_id)",
    );
    assert.equal(
      d.render(d.addColumn("users", "note", d.types.TXT.notNull().default(""))),
      "ALTER TABLE users ADD COLUMN note TEXT NOT NULL DEFAULT ''",
    );
  });
});

describe("ddl: rules are enforced", () => {
  const d = ddl("postgres");
  const { ID, TXT, INT, BOOL, TS } = d.types;

  test("nullability must be explicit and primary keys NOT NULL (rule 4)", () => {
    assert.throws(() => d.render(d.createTable("t", { id: ID.notNull().primaryKey(), note: TXT })), DdlError);
    assert.throws(() => d.render(d.createTable("t", { id: ID.nullable().primaryKey() })), DdlError);
    assert.throws(
      () => d.render(d.createTable("t", { a: ID.nullable(), b: ID.notNull() }, { primaryKey: ["a", "b"] })),
      DdlError,
    );
    assert.throws(() => d.render(d.createTable("t", { a: ID.notNull() })), /no primary key/);
  });

  test("CHECK: only length(), BETWEEN, comparisons, IS NULL, AND/OR (rule 5); no enumeration lists", () => {
    const columns = new Set(["kind", "video_id", "custom_name"]);
    assertPortableExpression("custom_name IS NULL OR length(custom_name) BETWEEN 1 AND 64", columns, "ok");
    assertPortableExpression("video_id = '*' OR length(video_id) = 11", columns, "ok");
    assertPortableExpression("kind >= 0 AND NOT (kind <> 3)", columns, "ok");
    assert.throws(() => {
      assertPortableExpression("kind IN ('a', 'b')", columns, "enum");
    }, DdlError);
    assert.throws(() => {
      assertPortableExpression("lower(kind) = 'a'", columns, "function");
    }, DdlError);
    assert.throws(() => {
      assertPortableExpression("other = 1", columns, "unknown column");
    }, DdlError);
    assert.throws(() => {
      assertPortableExpression("kind = 1;", columns, "semicolon");
    }, DdlError);
    assert.throws(() => {
      assertPortableExpression("(kind = 1", columns, "brackets");
    }, DdlError);
    assert.throws(() => d.render(d.createTable("t", { id: ID.notNull().primaryKey().check("id IN ('x')") })), DdlError);
  });

  test("DEFAULT must be a constant of the column's type (rule 6)", () => {
    assert.throws(() => d.render(d.createTable("t", { id: ID.notNull().primaryKey(), b: BOOL.notNull().default(2) })));
    assert.throws(() => d.render(d.createTable("t", { id: ID.notNull().primaryKey(), n: INT.notNull().default("1") })));
    assert.throws(() => d.render(d.createTable("t", { id: ID.notNull().primaryKey(), n: INT.notNull().default(1.5) })));
    assert.throws(() =>
      d.render(d.createTable("t", { id: ID.notNull().primaryKey(), n: INT.notNull().default(2_147_483_648) })),
    );
    assert.throws(() => d.render(d.createTable("t", { id: ID.notNull().primaryKey(), s: TXT.notNull().default(0) })));
    assert.match(
      d.render(d.createTable("t", { id: ID.notNull().primaryKey(), s: TXT.notNull().default("it's") })),
      /DEFAULT 'it''s'/,
    );
  });

  test("foreign key columns and referenced columns must be ID (rule 3)", async () => {
    assert.throws(
      () => d.render(d.createTable("t", { id: ID.notNull().primaryKey(), n: TS.notNull().references("users", "id") })),
      /must be ID/,
    );
    const recorded = ddl("sqlite");
    const { kysely, statements: executed } = recordingKysely("sqlite");
    await recorded.run(kysely, recorded.createTable("parents", { id: ID.notNull().primaryKey(), n: TS.notNull() }));
    assert.throws(
      () =>
        recorded.render(
          recorded.createTable(
            "children",
            { id: ID.notNull().primaryKey(), p: ID.notNull() },
            {
              foreignKeys: [{ columns: ["p"], table: "parents", references: ["n"] }],
            },
          ),
        ),
      /referenced column parents\.n must be ID/,
    );
    assert.throws(
      () =>
        recorded.render(
          recorded.createTable("children", {
            id: ID.notNull().primaryKey(),
            p: ID.notNull().references("parents", "x"),
          }),
        ),
      /does not exist/,
    );
    assert.equal(executed.length, 1);
    assert.deepEqual(
      recorded.model.tables.get("parents")?.columns.map((column) => [column.name, column.type, column.nullable]),
      [
        ["id", "ID", false],
        ["n", "TS", false],
      ],
    );
  });

  test("identifiers are lowercase, at most 63 characters and not reserved", () => {
    assert.throws(() => d.render(d.createTable("Users", { id: ID.notNull().primaryKey() })), DdlError);
    assert.throws(() => d.render(d.createTable("sqlite_x", { id: ID.notNull().primaryKey() })), DdlError);
    assert.throws(() => d.render(d.createTable("t".repeat(64), { id: ID.notNull().primaryKey() })), DdlError);
    assert.throws(() => d.render(d.createTable("t", { "bad name": ID.notNull().primaryKey() })), DdlError);
  });

  test("ADD COLUMN restrictions (SQLite)", () => {
    assert.throws(() => d.render(d.addColumn("users", "x", TXT.notNull())), /needs a DEFAULT/);
    assert.throws(() => d.render(d.addColumn("users", "x", ID.notNull().default("a").unique())), /UNIQUE/);
    assert.throws(() => d.render(d.addColumn("users", "x", ID.notNull().default("a").references("users", "id"))));
  });
});
