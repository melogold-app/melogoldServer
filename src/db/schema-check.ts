/**
 * Schema check at startup (DESIGN §6.2, m23): the live tables, columns (physical type and nullability) and indexes
 * are compared with `src/db/schema.snapshot.json`, which `npm run schema:sql` generates from the migrations.
 *
 * - `SCHEMA_CHECK=strict` (default): a difference throws {@link SchemaMismatchError}; the server exits with code 1.
 * - `SCHEMA_CHECK=warn`: the difference is logged and the server starts.
 * - When the database is newer than the code (unknown migrations applied, `migrate.ts`), tables and columns the
 *   snapshot does not know are only logged: migrations only expand the schema, so the old code still works.
 *
 * What is compared:
 * - every snapshot table exists; on SQLite it is `STRICT`;
 * - every snapshot column exists with the physical type of its logical type (API §9.1, including `COLLATE "C"` of
 *   `ID` on PostgreSQL) and the same nullability;
 * - the constraints: the primary key (columns in order), `UNIQUE` constraints, foreign keys (columns, referenced
 *   table and columns, `ON DELETE`) and `CHECK` expressions. Expressions are compared in the canonical form of
 *   `sql-expression.ts`, so SQLite's verbatim text and PostgreSQL's deparsed text of the same `CHECK` are equal;
 * - every snapshot index exists on its table with the same columns in order, `UNIQUE` flag and partial-index
 *   predicate (indexes an operator added are ignored; sort order, collation and operator class are not compared);
 * - tables, columns and constraints missing from the snapshot are differences too (except in "newer" mode).
 */
import { readFileSync } from "node:fs";
import { sql } from "kysely";
import type { QueryExecutorProvider } from "kysely";
import { z } from "zod";
import { LOGICAL_TYPES, physicalType } from "./ddl.ts";
import type { SqlDialect } from "./ddl.ts";
import { checkExpressions, comparableExpression, partialIndexPredicate } from "./sql-expression.ts";

const ON_DELETE = ["CASCADE", "SET NULL"] as const;

const snapshotSchema = z.object({
  migrations: z.array(z.string()),
  tables: z.record(
    z.string(),
    z.object({
      columns: z.array(z.object({ name: z.string(), type: z.enum(LOGICAL_TYPES), nullable: z.boolean() })),
      primaryKey: z.array(z.string()),
      unique: z.array(z.array(z.string())),
      foreignKeys: z.array(
        z.object({
          columns: z.array(z.string()),
          table: z.string(),
          references: z.array(z.string()),
          onDelete: z.enum(ON_DELETE).nullable(),
        }),
      ),
      checks: z.array(z.string()),
      indexes: z.array(
        z.object({
          name: z.string(),
          columns: z.array(z.string()),
          unique: z.boolean(),
          where: z.string().nullable(),
        }),
      ),
    }),
  ),
});

export type SchemaSnapshot = z.infer<typeof snapshotSchema>;

export const SNAPSHOT_URL = new URL("./schema.snapshot.json", import.meta.url);

/** Reads and validates the committed snapshot. */
export function loadSchemaSnapshot(url: URL = SNAPSHOT_URL): SchemaSnapshot {
  return snapshotSchema.parse(JSON.parse(readFileSync(url, "utf8")));
}

/** Tables Kysely's migrator owns; never part of the snapshot. */
const MIGRATOR_TABLES: ReadonlySet<string> = new Set(["kysely_migration", "kysely_migration_lock"]);

export type LiveColumn = Readonly<{
  name: string;
  /** SQLite: the declared type (`TEXT`, `INTEGER`); PostgreSQL: `data_type` plus `COLLATE "<name>"` when set. */
  physical: string;
  nullable: boolean;
}>;

export type LiveForeignKey = Readonly<{
  columns: readonly string[];
  table: string;
  references: readonly string[];
  /** `CASCADE`, `SET NULL`, `RESTRICT`, `SET DEFAULT`; `null` for `NO ACTION`. */
  onDelete: string | null;
}>;

export type LiveTable = Readonly<{
  name: string;
  columns: readonly LiveColumn[];
  /** SQLite: whether the table is `STRICT`; PostgreSQL: `null`. */
  strict: boolean | null;
  /** Primary key columns in key order (empty without one). */
  primaryKey: readonly string[];
  /** `UNIQUE` constraints, columns in order. */
  unique: readonly (readonly string[])[];
  foreignKeys: readonly LiveForeignKey[];
  /** `CHECK` expressions as the database returns them (SQLite: verbatim; PostgreSQL: deparsed). */
  checks: readonly string[];
}>;

export type LiveIndex = Readonly<{
  table: string;
  /** Key columns in order; an expression is `(expression)`. */
  columns: readonly string[];
  unique: boolean;
  /** The partial-index predicate as the database returns it, or `null`. */
  where: string | null;
}>;

export type LiveSchema = Readonly<{
  tables: ReadonlyMap<string, LiveTable>;
  /** Index name → definition (PostgreSQL also lists the indexes behind constraints; they are never looked up). */
  indexes: ReadonlyMap<string, LiveIndex>;
}>;

const SQLITE_ON_DELETE: Readonly<Record<string, string | null>> = { "NO ACTION": null };
const PG_ON_DELETE: Readonly<Record<string, string | null>> = {
  a: null,
  r: "RESTRICT",
  c: "CASCADE",
  n: "SET NULL",
  d: "SET DEFAULT",
};

/** Columns aggregated with `string_agg(…, ',')` (identifiers of the schema never contain commas). */
function splitColumns(list: string | null): string[] {
  return list === null || list === "" ? [] : list.split(",");
}

async function sqliteIndexColumns(kysely: QueryExecutorProvider, index: string): Promise<string[]> {
  const { rows } = await sql<{ name: string | null }>`
    SELECT name FROM pragma_index_info(${index}) ORDER BY seqno
  `.execute(kysely);
  return rows.map((row) => row.name ?? "(expression)");
}

async function introspectSqlite(kysely: QueryExecutorProvider): Promise<LiveSchema> {
  const tableRows = await sql<{ name: string; strict: number; sql: string | null }>`
    SELECT l.name, l.strict, s.sql FROM pragma_table_list AS l
    LEFT JOIN sqlite_schema AS s ON s.type = 'table' AND s.name = l.name
    WHERE l.schema = 'main' AND l.type = 'table' AND substr(l.name, 1, 7) <> 'sqlite_'
  `.execute(kysely);
  const tables = new Map<string, LiveTable>();
  const indexes = new Map<string, LiveIndex>();
  for (const { name, strict, sql: createTable } of tableRows.rows) {
    const columnRows = await sql<{ name: string; type: string; notnull: number; pk: number }>`
      SELECT name, type, "notnull", pk FROM pragma_table_info(${name}) ORDER BY cid
    `.execute(kysely);
    const foreignKeyRows = await sql<{ id: number; table: string; from: string; to: string; onDelete: string }>`
      SELECT id, "table", "from", "to", on_delete AS "onDelete" FROM pragma_foreign_key_list(${name}) ORDER BY id, seq
    `.execute(kysely);
    const foreignKeys = new Map<number, { columns: string[]; table: string; references: string[]; onDelete: string }>();
    for (const row of foreignKeyRows.rows) {
      const key = foreignKeys.get(row.id) ?? { columns: [], table: row.table, references: [], onDelete: row.onDelete };
      key.columns.push(row.from);
      key.references.push(row.to);
      foreignKeys.set(row.id, key);
    }
    const indexRows = await sql<{ name: string; unique: number; origin: string }>`
      SELECT name, "unique", origin FROM pragma_index_list(${name}) ORDER BY name
    `.execute(kysely);
    const unique: string[][] = [];
    for (const index of indexRows.rows) {
      if (index.origin === "u") unique.push(await sqliteIndexColumns(kysely, index.name));
      if (index.origin !== "c") continue;
      const definition = await sql<{ sql: string | null }>`
        SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ${index.name}
      `.execute(kysely);
      indexes.set(index.name, {
        table: name,
        columns: await sqliteIndexColumns(kysely, index.name),
        unique: index.unique === 1,
        where: partialIndexPredicate(definition.rows[0]?.sql ?? ""),
      });
    }
    tables.set(name, {
      name,
      strict: strict === 1,
      columns: columnRows.rows.map((column) => ({
        name: column.name,
        physical: column.type.toUpperCase(),
        nullable: column.notnull === 0,
      })),
      primaryKey: columnRows.rows
        .filter((column) => column.pk > 0)
        .sort((left, right) => left.pk - right.pk)
        .map((column) => column.name),
      unique,
      foreignKeys: [...foreignKeys.values()].map((key) => ({
        ...key,
        onDelete: key.onDelete in SQLITE_ON_DELETE ? (SQLITE_ON_DELETE[key.onDelete] ?? null) : key.onDelete,
      })),
      checks: checkExpressions(createTable ?? ""),
    });
  }
  return { tables, indexes };
}

async function introspectPostgres(kysely: QueryExecutorProvider): Promise<LiveSchema> {
  const tableRows = await sql<{ name: string }>`
    SELECT table_name AS name FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
  `.execute(kysely);
  const columnRows = await sql<{
    table: string;
    name: string;
    dataType: string;
    collation: string | null;
    isNullable: string;
  }>`
    SELECT table_name AS "table", column_name AS name, data_type AS "dataType", collation_name AS collation,
           is_nullable AS "isNullable"
    FROM information_schema.columns
    WHERE table_schema = current_schema()
    ORDER BY table_name, ordinal_position
  `.execute(kysely);
  const columns = new Map<string, LiveColumn[]>();
  for (const row of columnRows.rows) {
    const list = columns.get(row.table) ?? [];
    list.push({
      name: row.name,
      physical: row.collation === null ? row.dataType : `${row.dataType} COLLATE "${row.collation}"`,
      nullable: row.isNullable === "YES",
    });
    columns.set(row.table, list);
  }
  const constraintRows = await sql<{
    table: string;
    type: "p" | "u" | "f" | "c";
    columns: string | null;
    refTable: string | null;
    refColumns: string | null;
    onDelete: string;
    definition: string;
  }>`
    SELECT c.relname AS "table", con.contype AS type, f.relname AS "refTable", con.confdeltype AS "onDelete",
           pg_get_constraintdef(con.oid) AS definition,
           (SELECT string_agg(a.attname::text, ',' ORDER BY k.n)
              FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, n)
              JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS columns,
           (SELECT string_agg(a.attname::text, ',' ORDER BY k.n)
              FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, n)
              JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS "refColumns"
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    LEFT JOIN pg_class f ON f.oid = con.confrelid
    WHERE ns.nspname = current_schema() AND con.contype IN ('p', 'u', 'f', 'c')
    ORDER BY c.relname, con.conname
  `.execute(kysely);
  const tables = new Map<string, LiveTable>();
  for (const { name } of tableRows.rows) {
    const own = constraintRows.rows.filter((row) => row.table === name);
    tables.set(name, {
      name,
      strict: null,
      columns: columns.get(name) ?? [],
      primaryKey: splitColumns(own.find((row) => row.type === "p")?.columns ?? null),
      unique: own.filter((row) => row.type === "u").map((row) => splitColumns(row.columns)),
      foreignKeys: own
        .filter((row) => row.type === "f")
        .map((row) => ({
          columns: splitColumns(row.columns),
          table: row.refTable ?? "",
          references: splitColumns(row.refColumns),
          onDelete: row.onDelete in PG_ON_DELETE ? (PG_ON_DELETE[row.onDelete] ?? null) : row.onDelete,
        })),
      // `CHECK (<expression>)`, possibly followed by `NOT VALID`.
      checks: own
        .filter((row) => row.type === "c")
        .map((row) => row.definition.replace(/^CHECK\s*/i, "").replace(/\s+NOT VALID$/i, "")),
    });
  }
  const indexRows = await sql<{ name: string; table: string; unique: boolean; where: string | null; columns: string }>`
    SELECT ic.relname AS name, t.relname AS "table", ix.indisunique AS "unique",
           pg_get_expr(ix.indpred, ix.indrelid) AS "where",
           (SELECT string_agg(COALESCE(a.attname::text, '(expression)'), ',' ORDER BY k.n)
              FROM unnest(ix.indkey::int2[]) WITH ORDINALITY AS k(attnum, n)
              LEFT JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum
              WHERE k.n <= ix.indnkeyatts) AS columns
    FROM pg_index ix
    JOIN pg_class ic ON ic.oid = ix.indexrelid
    JOIN pg_class t ON t.oid = ix.indrelid
    JOIN pg_namespace ns ON ns.oid = t.relnamespace
    WHERE ns.nspname = current_schema()
  `.execute(kysely);
  const indexes = new Map<string, LiveIndex>();
  for (const row of indexRows.rows) {
    indexes.set(row.name, {
      table: row.table,
      columns: splitColumns(row.columns),
      unique: row.unique,
      where: row.where,
    });
  }
  return { tables, indexes };
}

/** Reads tables, columns, constraints and indexes of the current schema (PostgreSQL: `current_schema()`; SQLite: `main`). */
export function introspectSchema(kysely: QueryExecutorProvider, dialect: SqlDialect): Promise<LiveSchema> {
  return dialect === "sqlite" ? introspectSqlite(kysely) : introspectPostgres(kysely);
}

export type SchemaDiff = Readonly<{
  /** Missing or different tables, columns, constraints and indexes. */
  problems: readonly string[];
  /** Tables, columns and constraints the snapshot does not know. */
  extras: readonly string[];
}>;

const columnList = (columns: readonly string[]) => `(${columns.join(", ")})`;

function foreignKeyText(
  key: Readonly<{ columns: readonly string[]; table: string; references: readonly string[]; onDelete: string | null }>,
): string {
  const onDelete = key.onDelete === null ? "" : ` ON DELETE ${key.onDelete}`;
  return `${columnList(key.columns)} REFERENCES ${key.table}${columnList(key.references)}${onDelete}`;
}

/**
 * Matches expected against live items by a comparison key: what is expected but not live is a problem, what is live
 * but not expected is an extra (both described by `describe`).
 */
function compareSets<E, L>(
  expected: readonly E[],
  live: readonly L[],
  keys: Readonly<{ expected: (item: E) => string; live: (item: L) => string }>,
  describe: Readonly<{ missing: (item: E) => string; extra: (item: L) => string }>,
  out: Readonly<{ problems: string[]; extras: string[] }>,
): void {
  const remaining = live.map((item) => ({ item, key: keys.live(item), used: false }));
  for (const item of expected) {
    const key = keys.expected(item);
    const match = remaining.find((candidate) => !candidate.used && candidate.key === key);
    if (match) match.used = true;
    else out.problems.push(describe.missing(item));
  }
  for (const candidate of remaining) if (!candidate.used) out.extras.push(describe.extra(candidate.item));
}

/** Compares a live schema with the snapshot (pure). */
export function compareSchema(snapshot: SchemaSnapshot, live: LiveSchema, dialect: SqlDialect): SchemaDiff {
  const problems: string[] = [];
  const extras: string[] = [];
  for (const [tableName, table] of Object.entries(snapshot.tables)) {
    const liveTable = live.tables.get(tableName);
    if (!liveTable) {
      problems.push(`table ${tableName} is missing`);
      continue;
    }
    if (liveTable.strict === false) problems.push(`table ${tableName} is not STRICT`);
    const liveColumns = new Map(liveTable.columns.map((column) => [column.name, column]));
    for (const column of table.columns) {
      const where = `${tableName}.${column.name}`;
      const liveColumn = liveColumns.get(column.name);
      if (!liveColumn) {
        problems.push(`column ${where} is missing`);
        continue;
      }
      const expected = physicalType(dialect, column.type);
      if (liveColumn.physical !== expected) {
        problems.push(`column ${where} has type ${liveColumn.physical}, expected ${expected} (${column.type})`);
      }
      if (liveColumn.nullable !== column.nullable) {
        problems.push(`column ${where} is ${liveColumn.nullable ? "NULL" : "NOT NULL"}, expected the opposite`);
      }
      liveColumns.delete(column.name);
    }
    for (const extra of liveColumns.keys()) extras.push(`column ${tableName}.${extra} is not in the snapshot`);

    const out = { problems, extras };
    if (columnList(liveTable.primaryKey) !== columnList(table.primaryKey)) {
      problems.push(
        `table ${tableName} has primary key ${columnList(liveTable.primaryKey)}, expected ${columnList(table.primaryKey)}`,
      );
    }
    compareSets(
      table.unique,
      liveTable.unique,
      { expected: columnList, live: columnList },
      {
        missing: (columns) => `unique ${columnList(columns)} on ${tableName} is missing`,
        extra: (columns) => `unique ${columnList(columns)} on ${tableName} is not in the snapshot`,
      },
      out,
    );
    compareSets(
      table.foreignKeys,
      liveTable.foreignKeys,
      { expected: foreignKeyText, live: foreignKeyText },
      {
        missing: (key) => `foreign key ${foreignKeyText(key)} on ${tableName} is missing`,
        extra: (key) => `foreign key ${foreignKeyText(key)} on ${tableName} is not in the snapshot`,
      },
      out,
    );
    compareSets(
      table.checks,
      liveTable.checks,
      { expected: comparableExpression, live: comparableExpression },
      {
        missing: (check) => `check (${check}) on ${tableName} is missing`,
        extra: (check) => `check (${check}) on ${tableName} is not in the snapshot`,
      },
      out,
    );

    for (const index of table.indexes) {
      const liveIndex = live.indexes.get(index.name);
      if (liveIndex === undefined) {
        problems.push(`index ${index.name} is missing`);
        continue;
      }
      if (liveIndex.table !== tableName) {
        problems.push(`index ${index.name} is on ${liveIndex.table}, expected ${tableName}`);
        continue;
      }
      if (columnList(liveIndex.columns) !== columnList(index.columns)) {
        problems.push(
          `index ${index.name} is on ${columnList(liveIndex.columns)}, expected ${columnList(index.columns)}`,
        );
      }
      if (liveIndex.unique !== index.unique) {
        problems.push(`index ${index.name} is ${liveIndex.unique ? "UNIQUE" : "not UNIQUE"}, expected the opposite`);
      }
      const liveWhere = liveIndex.where === null ? null : comparableExpression(liveIndex.where);
      const expectedWhere = index.where === null ? null : comparableExpression(index.where);
      if (liveWhere !== expectedWhere) {
        problems.push(
          `index ${index.name} has predicate ${liveIndex.where === null ? "none" : `WHERE ${liveIndex.where}`}, ` +
            `expected ${index.where === null ? "none" : `WHERE ${index.where}`}`,
        );
      }
    }
  }
  for (const name of live.tables.keys()) {
    if (!(name in snapshot.tables) && !MIGRATOR_TABLES.has(name)) extras.push(`table ${name} is not in the snapshot`);
  }
  return { problems, extras };
}

/** The live schema differs from the snapshot under `SCHEMA_CHECK=strict`: the process exits with code 1. */
export class SchemaMismatchError extends Error {
  readonly exitCode = 1;
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `the database schema differs from src/db/schema.snapshot.json:\n- ${problems.join("\n- ")}\n` +
        "Restore the database or run the matching version; SCHEMA_CHECK=warn starts anyway at your own risk.",
    );
    this.name = "SchemaMismatchError";
    this.problems = problems;
  }
}

export type SchemaCheckLogger = { warn(details: object, message: string): void };

export type SchemaCheckOptions = Readonly<{
  /** `SCHEMA_CHECK` (API §10). */
  mode: "strict" | "warn";
  log: SchemaCheckLogger;
  /** The database is newer than the code (`migrate.ts` returned `schema_newer`): unknown tables/columns only warn. */
  schemaNewer?: boolean;
  snapshot?: SchemaSnapshot;
}>;

export type SchemaCheckResult = Readonly<{ ok: boolean; problems: readonly string[]; extras: readonly string[] }>;

/**
 * Runs the startup check.
 * @throws SchemaMismatchError under `mode: "strict"` when the schema differs.
 */
export async function checkSchema(
  kysely: QueryExecutorProvider,
  dialect: SqlDialect,
  options: SchemaCheckOptions,
): Promise<SchemaCheckResult> {
  const snapshot = options.snapshot ?? loadSchemaSnapshot();
  const diff = compareSchema(snapshot, await introspectSchema(kysely, dialect), dialect);
  const newer = options.schemaNewer === true;
  const blocking = newer ? diff.problems : [...diff.problems, ...diff.extras];
  if (newer && diff.extras.length > 0) {
    options.log.warn({ extras: diff.extras }, "the database has tables or columns this version does not know");
  }
  if (blocking.length === 0) return { ok: true, problems: [], extras: diff.extras };
  if (options.mode === "strict") throw new SchemaMismatchError(blocking);
  options.log.warn(
    { problems: blocking },
    "the database schema differs from src/db/schema.snapshot.json; starting because SCHEMA_CHECK=warn",
  );
  return { ok: false, problems: blocking, extras: diff.extras };
}
