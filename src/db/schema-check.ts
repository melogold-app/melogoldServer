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
 * - every snapshot index exists on its table (constraint indexes and indexes an operator added are ignored);
 * - tables and columns missing from the snapshot are differences too (except in "newer" mode).
 */
import { readFileSync } from "node:fs";
import { sql } from "kysely";
import type { QueryExecutorProvider } from "kysely";
import { z } from "zod";
import { LOGICAL_TYPES, physicalType } from "./ddl.ts";
import type { SqlDialect } from "./ddl.ts";

const snapshotSchema = z.object({
  migrations: z.array(z.string()),
  tables: z.record(
    z.string(),
    z.object({
      columns: z.array(z.object({ name: z.string(), type: z.enum(LOGICAL_TYPES), nullable: z.boolean() })),
      indexes: z.array(z.string()),
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

export type LiveTable = Readonly<{
  name: string;
  columns: readonly LiveColumn[];
  /** SQLite: whether the table is `STRICT`; PostgreSQL: `null`. */
  strict: boolean | null;
}>;

export type LiveSchema = Readonly<{
  tables: ReadonlyMap<string, LiveTable>;
  /** Index name → table name. */
  indexes: ReadonlyMap<string, string>;
}>;

async function introspectSqlite(kysely: QueryExecutorProvider): Promise<LiveSchema> {
  const tableRows = await sql<{ name: string; strict: number }>`
    SELECT name, strict FROM pragma_table_list
    WHERE schema = 'main' AND type = 'table' AND substr(name, 1, 7) <> 'sqlite_'
  `.execute(kysely);
  const tables = new Map<string, LiveTable>();
  for (const { name, strict } of tableRows.rows) {
    const columnRows = await sql<{ name: string; type: string; notnull: number }>`
      SELECT name, type, "notnull" FROM pragma_table_info(${name}) ORDER BY cid
    `.execute(kysely);
    tables.set(name, {
      name,
      strict: strict === 1,
      columns: columnRows.rows.map((column) => ({
        name: column.name,
        physical: column.type.toUpperCase(),
        nullable: column.notnull === 0,
      })),
    });
  }
  const indexRows = await sql<{ name: string; table: string }>`
    SELECT name, tbl_name AS "table" FROM sqlite_schema WHERE type = 'index' AND sql IS NOT NULL
  `.execute(kysely);
  return { tables, indexes: new Map(indexRows.rows.map((row) => [row.name, row.table])) };
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
  const tables = new Map<string, LiveTable>();
  for (const { name } of tableRows.rows) tables.set(name, { name, strict: null, columns: columns.get(name) ?? [] });
  const indexRows = await sql<{ name: string; table: string }>`
    SELECT indexname AS name, tablename AS "table" FROM pg_indexes WHERE schemaname = current_schema()
  `.execute(kysely);
  return { tables, indexes: new Map(indexRows.rows.map((row) => [row.name, row.table])) };
}

/** Reads tables, columns and indexes of the current schema (PostgreSQL: `current_schema()`; SQLite: `main`). */
export function introspectSchema(kysely: QueryExecutorProvider, dialect: SqlDialect): Promise<LiveSchema> {
  return dialect === "sqlite" ? introspectSqlite(kysely) : introspectPostgres(kysely);
}

export type SchemaDiff = Readonly<{
  /** Missing or different tables, columns and indexes. */
  problems: readonly string[];
  /** Tables and columns the snapshot does not know. */
  extras: readonly string[];
}>;

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
    for (const index of table.indexes) {
      const indexTable = live.indexes.get(index);
      if (indexTable === undefined) problems.push(`index ${index} is missing`);
      else if (indexTable !== tableName) problems.push(`index ${index} is on ${indexTable}, expected ${tableName}`);
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
