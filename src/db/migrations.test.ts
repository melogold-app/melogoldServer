/**
 * The migrations are the DDL of API §9.2, statement for statement, in both dialects: the SQL block of docs/API.md is
 * rendered with the macro table of API §9.1 and compared with what the migrations execute.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { ddl, recordingKysely } from "./ddl.ts";
import type { SqlDialect } from "./ddl.ts";
import { MIGRATIONS } from "./migrations/index.ts";

const MACROS: Readonly<Record<SqlDialect, Readonly<Record<string, string>>>> = {
  sqlite: { ID: "TEXT", TXT: "TEXT", INT: "INTEGER", BIG: "INTEGER", TS: "INTEGER", JSON: "TEXT", BOOL: "INTEGER" },
  postgres: {
    ID: 'text COLLATE "C"',
    TXT: "text",
    INT: "integer",
    BIG: "bigint",
    TS: "bigint",
    JSON: "text",
    BOOL: "integer",
  },
};

function normalize(statement: string): string {
  return statement.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").replace(/ ,/g, ",").trim();
}

/** The SQL block of API §9.2, split by migration, without comments. */
function apiSections(): Map<string, string[]> {
  const api = readFileSync(new URL("../../docs/API.md", import.meta.url), "utf8");
  const start = api.indexOf("### 9.2 DDL");
  const block = /```sql\n([\s\S]*?)```/.exec(api.slice(start))?.[1];
  assert.ok(block, "API §9.2 SQL block not found");
  const sections = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of block.split("\n")) {
    const banner = /^-- =+ (\d{4}_\w+) =+/.exec(line);
    if (banner?.[1]) {
      current = [];
      sections.set(banner[1], current);
      continue;
    }
    current?.push(line.replace(/--.*$/, ""));
  }
  const statements = new Map<string, string[]>();
  for (const [name, lines] of sections) {
    statements.set(
      name,
      lines
        .join("\n")
        .split(";")
        .map((statement) => statement.trim())
        .filter((statement) => statement !== ""),
    );
  }
  return statements;
}

/** Applies the macro table of API §9.1 (`BOOL` also gets `CHECK (<col> IN (0,1))` at the end of its definition). */
function expand(statement: string, dialect: SqlDialect): string {
  const macros = MACROS[dialect];
  const withBool = statement.replace(/\b(\w+)\s+BOOL\b([^,\n]*)/g, (_match, column: string, rest: string) => {
    return `${column} BOOL${rest} CHECK (${column} IN (0,1))`;
  });
  const typed = withBool.replace(/\b(ID|TXT|INT|BIG|TS|JSON|BOOL)\b/g, (macro) => macros[macro] ?? macro);
  const table = statement.startsWith("CREATE TABLE") && dialect === "sqlite" ? `${typed} STRICT` : typed;
  return normalize(table);
}

async function migrationSections(dialect: SqlDialect): Promise<Map<string, string[]>> {
  const d = ddl(dialect);
  const { kysely, statements } = recordingKysely(dialect);
  const sections = new Map<string, string[]>();
  for (const migration of MIGRATIONS) {
    const start = statements.length;
    await migration.up(kysely, d);
    sections.set(migration.name, statements.slice(start).map(normalize));
  }
  await kysely.destroy();
  return sections;
}

describe("migrations = API §9.2", () => {
  const api = apiSections();

  test("the same migrations, in the same order", () => {
    assert.deepEqual(
      MIGRATIONS.map((migration) => migration.name),
      [...api.keys()],
    );
  });

  for (const dialect of ["sqlite", "postgres"] as const) {
    test(`every statement matches the API text rendered for ${dialect}`, async () => {
      const rendered = await migrationSections(dialect);
      for (const [name, statements] of api) {
        const expected = statements.map((statement) => expand(statement, dialect));
        assert.deepEqual(rendered.get(name), expected, `${name} (${dialect})`);
      }
    });
  }
});
