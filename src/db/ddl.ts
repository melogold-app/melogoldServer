/**
 * DDL helper `ddl(dialect)`: the only place that turns the logical column types of API §9.1 into SQL.
 *
 * Migrations describe tables with {@link Ddl.types} and {@link Ddl.createTable}/{@link Ddl.createIndex}; this module
 * renders the same description for SQLite and PostgreSQL and enforces the rendering rules of API §9.1:
 * 1. column types come only from the logical types (`ID`, `TXT`, `INT`, `BIG`, `TS`, `BOOL`, `JSON`);
 * 2. every SQLite table ends with `STRICT`;
 * 3. `COLLATE "C"` is added only in PostgreSQL and only to `ID`; columns in foreign keys must be `ID`;
 * 4. every column states `NULL` or `NOT NULL`, primary key columns are `NOT NULL`;
 * 5. `CHECK` uses only `length()`, `BETWEEN`, comparisons, `IS [NOT] NULL`, `AND`/`OR`; `IN (0,1)` is generated for
 *    `BOOL` and nowhere else (no enumeration lists in the database);
 * 6. `DEFAULT` is a constant;
 * 7. no triggers, functions, `serial`, `jsonb` or arrays: there is simply no way to express them here.
 *
 * Rule 8 (`PRAGMA auto_vacuum=INCREMENTAL` before the first table) lives in `dialect-sqlite.ts`.
 * The executed statements are also the source of `docs/schema.*.sql` (`scripts/gen-schema-sql.ts`), and the model
 * collected while running them is the source of `schema.snapshot.json` and `types.ts`.
 */
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  sql,
} from "kysely";
import type { DatabaseConnection, Driver, QueryExecutorProvider, QueryResult } from "kysely";

export type SqlDialect = "sqlite" | "postgres";

export const LOGICAL_TYPES = ["ID", "TXT", "INT", "BIG", "TS", "BOOL", "JSON"] as const;
export type LogicalType = (typeof LOGICAL_TYPES)[number];

export type OnDelete = "CASCADE" | "SET NULL";

/** SQL type of each logical type (API §9.1). `BOOL` also gets `CHECK (<col> IN (0,1))`. */
const PHYSICAL_TYPES: Readonly<Record<SqlDialect, Readonly<Record<LogicalType, string>>>> = {
  postgres: {
    ID: 'text COLLATE "C"',
    TXT: "text",
    INT: "integer",
    BIG: "bigint",
    TS: "bigint",
    BOOL: "integer",
    JSON: "text",
  },
  sqlite: {
    ID: "TEXT",
    TXT: "TEXT",
    INT: "INTEGER",
    BIG: "INTEGER",
    TS: "INTEGER",
    BOOL: "INTEGER",
    JSON: "TEXT",
  },
};

export function physicalType(dialect: SqlDialect, type: LogicalType): string {
  return PHYSICAL_TYPES[dialect][type];
}

/** Largest integer a column may hold (API §1.4, §9.1). */
const INT32_MAX = 2_147_483_647;

// ---------------------------------------------------------------------------------------------------------------------
// Column builder
// ---------------------------------------------------------------------------------------------------------------------

export type ColumnReference = Readonly<{ table: string; column: string; onDelete: OnDelete | null }>;

export type ColumnSpec = Readonly<{
  type: LogicalType;
  /** `undefined` until `.notNull()` or `.nullable()` is called; rendering requires an explicit choice (rule 4). */
  nullable: boolean | undefined;
  primaryKey: boolean;
  unique: boolean;
  default: string | number | undefined;
  checks: readonly string[];
  references: ColumnReference | undefined;
}>;

/** Immutable column description; every method returns a new builder. */
export class Column {
  readonly #spec: ColumnSpec;

  constructor(spec: ColumnSpec) {
    this.#spec = Object.freeze({ ...spec, checks: Object.freeze([...spec.checks]) });
  }

  get spec(): ColumnSpec {
    return this.#spec;
  }

  #with(patch: Partial<ColumnSpec>): Column {
    return new Column({ ...this.#spec, ...patch });
  }

  notNull(): Column {
    return this.#with({ nullable: false });
  }

  nullable(): Column {
    return this.#with({ nullable: true });
  }

  primaryKey(): Column {
    return this.#with({ primaryKey: true });
  }

  unique(): Column {
    return this.#with({ unique: true });
  }

  /** A constant default (rule 6): a string for `ID`/`TXT`/`JSON`, an integer for numeric types, 0 or 1 for `BOOL`. */
  default(value: string | number): Column {
    return this.#with({ default: value });
  }

  /** A `CHECK` expression limited to the portable subset of rule 5, e.g. `length(login) BETWEEN 3 AND 64`. */
  check(expression: string): Column {
    return this.#with({ checks: [...this.#spec.checks, expression] });
  }

  references(table: string, column: string, onDelete?: OnDelete): Column {
    return this.#with({ references: { table, column, onDelete: onDelete ?? null } });
  }
}

function baseColumn(type: LogicalType): Column {
  return new Column({
    type,
    nullable: undefined,
    primaryKey: false,
    unique: false,
    default: undefined,
    checks: [],
    references: undefined,
  });
}

export type ColumnTypes = Readonly<Record<LogicalType, Column>>;

export const COLUMN_TYPES: ColumnTypes = Object.freeze({
  ID: baseColumn("ID"),
  TXT: baseColumn("TXT"),
  INT: baseColumn("INT"),
  BIG: baseColumn("BIG"),
  TS: baseColumn("TS"),
  BOOL: baseColumn("BOOL"),
  JSON: baseColumn("JSON"),
});

// ---------------------------------------------------------------------------------------------------------------------
// Schema model (what the executed statements produce)
// ---------------------------------------------------------------------------------------------------------------------

export type ModelColumn = Readonly<{
  name: string;
  type: LogicalType;
  nullable: boolean;
  hasDefault: boolean;
  /** The constant of `DEFAULT` (rule 6), `null` without one. */
  default: string | number | null;
}>;
/** A `CREATE INDEX` (constraint indexes of `PRIMARY KEY` and `UNIQUE` are not indexes of the model). */
export type ModelIndex = Readonly<{
  name: string;
  table: string;
  columns: readonly string[];
  unique: boolean;
  /** The partial-index predicate as written in the migration. */
  where: string | null;
}>;
export type ModelForeignKey = Readonly<{
  columns: readonly string[];
  table: string;
  references: readonly string[];
  onDelete: OnDelete | null;
}>;
export type ModelTable = {
  readonly name: string;
  readonly columns: ModelColumn[];
  readonly primaryKey: readonly string[];
  /** `UNIQUE` constraints (column `.unique()` and `options.unique`), columns in order. */
  readonly unique: (readonly string[])[];
  readonly foreignKeys: ModelForeignKey[];
  /** `CHECK` expressions as written, including the generated `<col> IN (0,1)` of `BOOL`. */
  readonly checks: string[];
  readonly indexes: ModelIndex[];
};

export type SchemaModel = {
  /** Tables in creation order, with their constraints and indexes. */
  readonly tables: Map<string, ModelTable>;
  readonly indexes: Map<string, ModelIndex>;
};

export function emptyModel(): SchemaModel {
  return { tables: new Map(), indexes: new Map() };
}

// ---------------------------------------------------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------------------------------------------------

export type ForeignKeySpec = Readonly<{
  columns: readonly string[];
  table: string;
  references: readonly string[];
  onDelete?: OnDelete;
}>;

export type TableOptions = Readonly<{
  /** Composite primary key; a single-column key uses `.primaryKey()` on the column instead. */
  primaryKey?: readonly string[];
  unique?: readonly (readonly string[])[];
  foreignKeys?: readonly ForeignKeySpec[];
}>;

export type IndexOptions = Readonly<{ unique?: boolean; where?: string }>;

/**
 * A statement is rendered lazily, right before it runs, so that validation sees every table created by the
 * statements before it (for example the type of a referenced column).
 */
export type DdlStatement = Readonly<{
  /** `CREATE TABLE users`, for error messages. */
  description: string;
  build(): BuiltStatement;
}>;

export type BuiltStatement = Readonly<{ sql: string; apply(): void }>;

export class DdlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DdlError";
  }
}

const IDENTIFIER = /^[a-z][a-z0-9_]*$/;
/** PostgreSQL truncates longer identifiers (NAMEDATALEN − 1). */
const MAX_IDENTIFIER_LENGTH = 63;

function assertIdentifier(kind: string, name: string): void {
  if (!IDENTIFIER.test(name) || name.length > MAX_IDENTIFIER_LENGTH) {
    throw new DdlError(`${kind} name "${name}" must match ${IDENTIFIER.source} and be at most 63 characters`);
  }
  if (name.startsWith("sqlite_") || name.startsWith("pg_") || name.startsWith("kysely_")) {
    throw new DdlError(`${kind} name "${name}" uses a reserved prefix`);
  }
}

const EXPRESSION_KEYWORDS = new Set(["length", "between", "and", "or", "is", "not", "null"]);
const EXPRESSION_TOKEN = /\s*(?:('(?:[^']|'')*')|(\d+)|([A-Za-z_][A-Za-z0-9_]*)|(<>|!=|<=|>=|=|<|>)|([(),]))/y;

/**
 * Validates a `CHECK` or partial-index expression against the portable subset (rule 5): column names of the table,
 * integer and string literals, comparisons, `length()`, `BETWEEN`, `IS [NOT] NULL`, `AND`, `OR`, `NOT` and brackets.
 * `columns = "any"` accepts any lowercase identifier: used when the table was created by a migration that is not part
 * of this run (the full check happens whenever all migrations run from scratch: tests and `npm run schema:sql`).
 */
export function assertPortableExpression(
  expression: string,
  columns: ReadonlySet<string> | "any",
  where: string,
): void {
  let position = 0;
  let depth = 0;
  while (position < expression.length) {
    if (/^\s*$/.test(expression.slice(position))) break;
    EXPRESSION_TOKEN.lastIndex = position;
    const match = EXPRESSION_TOKEN.exec(expression);
    if (!match) {
      throw new DdlError(`${where}: unsupported syntax at "${expression.slice(position)}" in "${expression}"`);
    }
    position = EXPRESSION_TOKEN.lastIndex;
    const word = match[3];
    const punctuation = match[5];
    if (word !== undefined) {
      const lower = word.toLowerCase();
      if (!EXPRESSION_KEYWORDS.has(lower) && (columns === "any" ? !IDENTIFIER.test(word) : !columns.has(word))) {
        throw new DdlError(
          `${where}: "${word}" is neither a column of the table nor an allowed keyword ` +
            `(length, BETWEEN, AND, OR, IS, NOT, NULL); enumeration lists are validated by zod, not by the database`,
        );
      }
    } else if (punctuation === "(") {
      depth++;
    } else if (punctuation === ")") {
      depth--;
      if (depth < 0) throw new DdlError(`${where}: unbalanced brackets in "${expression}"`);
    } else if (punctuation === ",") {
      throw new DdlError(`${where}: lists are not allowed in "${expression}"`);
    }
  }
  if (depth !== 0) throw new DdlError(`${where}: unbalanced brackets in "${expression}"`);
}

function renderDefault(column: string, spec: ColumnSpec): string {
  const value = spec.default;
  if (value === undefined) return "";
  if (spec.type === "BOOL") {
    if (value !== 0 && value !== 1) throw new DdlError(`${column}: BOOL default must be 0 or 1`);
    return ` DEFAULT ${value}`;
  }
  if (spec.type === "INT" || spec.type === "BIG" || spec.type === "TS") {
    const max = spec.type === "INT" ? INT32_MAX : Number.MAX_SAFE_INTEGER;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || Math.abs(value) > max) {
      throw new DdlError(`${column}: ${spec.type} default must be an integer constant within range`);
    }
    return ` DEFAULT ${value}`;
  }
  if (typeof value !== "string") throw new DdlError(`${column}: ${spec.type} default must be a string constant`);
  return ` DEFAULT '${value.replaceAll("'", "''")}'`;
}

// ---------------------------------------------------------------------------------------------------------------------
// ddl(dialect)
// ---------------------------------------------------------------------------------------------------------------------

export type Ddl = {
  readonly dialect: SqlDialect;
  readonly types: ColumnTypes;
  /** Tables and indexes created by the statements executed through {@link Ddl.run} so far. */
  readonly model: SchemaModel;
  createTable(name: string, columns: Readonly<Record<string, Column>>, options?: TableOptions): DdlStatement;
  createIndex(name: string, table: string, columns: readonly string[], options?: IndexOptions): DdlStatement;
  /** `ALTER TABLE … ADD COLUMN` for expanding migrations: nullable, or `NOT NULL` with a default. */
  addColumn(table: string, name: string, column: Column): DdlStatement;
  /** Executes the statements in order (inside the migration transaction) and records them in {@link Ddl.model}. */
  run(db: QueryExecutorProvider, ...statements: DdlStatement[]): Promise<void>;
  /** Renders a statement against the current model without executing or recording it (tests, tooling). */
  render(statement: DdlStatement): string;
};

/** Creates the DDL helper for a dialect. Each instance keeps its own {@link SchemaModel}. */
export function ddl(dialect: SqlDialect): Ddl {
  const model = emptyModel();

  function knownColumnType(table: string, column: string): LogicalType | undefined {
    return model.tables.get(table)?.columns.find((candidate) => candidate.name === column)?.type;
  }

  function assertReference(where: string, localType: LogicalType, table: string, column: string): void {
    assertIdentifier("table", table);
    assertIdentifier("column", column);
    if (localType !== "ID") throw new DdlError(`${where}: foreign key columns must be ID (rule 3)`);
    const referencedType = knownColumnType(table, column);
    if (model.tables.has(table) && referencedType === undefined) {
      throw new DdlError(`${where}: ${table}.${column} does not exist`);
    }
    if (referencedType !== undefined && referencedType !== "ID") {
      throw new DdlError(`${where}: referenced column ${table}.${column} must be ID (rule 3)`);
    }
  }

  function renderColumn(table: string, name: string, spec: ColumnSpec, columns: ReadonlySet<string> | "any"): string {
    const where = `${table}.${name}`;
    assertIdentifier("column", name);
    if (spec.nullable === undefined) throw new DdlError(`${where}: call .notNull() or .nullable() (rule 4)`);
    if (spec.primaryKey && spec.nullable) throw new DdlError(`${where}: primary key columns must be NOT NULL (rule 4)`);

    let text = `${physicalType(dialect, spec.type)} ${spec.nullable ? "NULL" : "NOT NULL"}`;
    if (spec.primaryKey) text += " PRIMARY KEY";
    if (spec.unique) text += " UNIQUE";
    text += renderDefault(where, spec);
    if (spec.references) {
      const { table: refTable, column: refColumn, onDelete } = spec.references;
      assertReference(where, spec.type, refTable, refColumn);
      text += ` REFERENCES ${refTable}(${refColumn})`;
      if (onDelete) text += ` ON DELETE ${onDelete}`;
    }
    if (spec.type === "BOOL") text += ` CHECK (${name} IN (0,1))`;
    for (const check of spec.checks) {
      assertPortableExpression(check, columns, `${where} CHECK`);
      text += ` CHECK (${check})`;
    }
    return text;
  }

  /** The `CHECK` expressions a column renders, in rendering order. */
  function columnChecks(name: string, spec: ColumnSpec): string[] {
    return [...(spec.type === "BOOL" ? [`${name} IN (0,1)`] : []), ...spec.checks];
  }

  function columnForeignKey(name: string, spec: ColumnSpec): ModelForeignKey | null {
    if (!spec.references) return null;
    const { table, column, onDelete } = spec.references;
    return Object.freeze({ columns: [name], table, references: [column], onDelete });
  }

  function toModelColumn(name: string, spec: ColumnSpec): ModelColumn {
    return Object.freeze({
      name,
      type: spec.type,
      nullable: spec.nullable === true,
      hasDefault: spec.default !== undefined,
      default: spec.default ?? null,
    });
  }

  function assertColumnList(where: string, list: readonly string[], columns: ReadonlySet<string>): void {
    if (list.length === 0) throw new DdlError(`${where}: empty column list`);
    for (const column of list) {
      if (!columns.has(column)) throw new DdlError(`${where}: unknown column "${column}"`);
    }
    if (new Set(list).size !== list.length) throw new DdlError(`${where}: duplicate column`);
  }

  function buildCreateTable(
    name: string,
    columnBuilders: Readonly<Record<string, Column>>,
    options: TableOptions,
  ): BuiltStatement {
    assertIdentifier("table", name);
    if (model.tables.has(name)) throw new DdlError(`table ${name} already exists`);
    const entries = Object.entries(columnBuilders);
    if (entries.length === 0) throw new DdlError(`${name}: a table needs columns`);
    const columnNames = new Set(entries.map(([column]) => column));
    const specs = new Map(entries.map(([column, builder]) => [column, builder.spec]));

    const inlinePrimaryKeys = entries.filter(([, builder]) => builder.spec.primaryKey).map(([column]) => column);
    if (inlinePrimaryKeys.length > 1) {
      throw new DdlError(`${name}: several .primaryKey() columns; use options.primaryKey for a composite key`);
    }
    if (inlinePrimaryKeys.length === 1 && options.primaryKey) {
      throw new DdlError(`${name}: both an inline and a composite primary key`);
    }
    if (inlinePrimaryKeys.length === 0 && !options.primaryKey) throw new DdlError(`${name}: no primary key`);

    const width = Math.max(...entries.map(([column]) => column.length));
    const lines = entries.map(
      ([column, builder]) => `${column.padEnd(width)} ${renderColumn(name, column, builder.spec, columnNames)}`,
    );

    if (options.primaryKey) {
      assertColumnList(`${name} PRIMARY KEY`, options.primaryKey, columnNames);
      for (const column of options.primaryKey) {
        if (specs.get(column)?.nullable !== false) {
          throw new DdlError(`${name}.${column}: primary key columns must be NOT NULL (rule 4)`);
        }
      }
      lines.push(`PRIMARY KEY (${options.primaryKey.join(", ")})`);
    }
    for (const unique of options.unique ?? []) {
      assertColumnList(`${name} UNIQUE`, unique, columnNames);
      lines.push(`UNIQUE (${unique.join(", ")})`);
    }
    for (const foreignKey of options.foreignKeys ?? []) {
      const where = `${name} FOREIGN KEY`;
      assertColumnList(where, foreignKey.columns, columnNames);
      if (foreignKey.columns.length !== foreignKey.references.length) {
        throw new DdlError(`${where}: column count differs from the referenced column count`);
      }
      foreignKey.columns.forEach((column, index) => {
        const referenced = foreignKey.references[index];
        const type = specs.get(column)?.type;
        if (referenced === undefined || type === undefined) throw new DdlError(`${where}: invalid column list`);
        assertReference(`${where} (${column})`, type, foreignKey.table, referenced);
      });
      const localColumns = foreignKey.columns.join(", ");
      const referencedColumns = foreignKey.references.join(", ");
      let line = `FOREIGN KEY (${localColumns}) REFERENCES ${foreignKey.table} (${referencedColumns})`;
      if (foreignKey.onDelete) line += ` ON DELETE ${foreignKey.onDelete}`;
      lines.push(line);
    }

    const body = lines.map((line) => `  ${line}`).join(",\n");
    const columns = entries.map(([column, builder]) => toModelColumn(column, builder.spec));
    const table: ModelTable = {
      name,
      columns,
      primaryKey: Object.freeze([...(options.primaryKey ?? inlinePrimaryKeys)]),
      unique: [
        ...entries.filter(([, builder]) => builder.spec.unique).map(([column]) => Object.freeze([column])),
        ...(options.unique ?? []).map((unique) => Object.freeze([...unique])),
      ],
      foreignKeys: [
        ...entries.flatMap(([column, builder]) => columnForeignKey(column, builder.spec) ?? []),
        ...(options.foreignKeys ?? []).map((foreignKey) =>
          Object.freeze({
            columns: [...foreignKey.columns],
            table: foreignKey.table,
            references: [...foreignKey.references],
            onDelete: foreignKey.onDelete ?? null,
          }),
        ),
      ],
      checks: entries.flatMap(([column, builder]) => columnChecks(column, builder.spec)),
      indexes: [],
    };
    return Object.freeze({
      sql: `CREATE TABLE ${name} (\n${body}\n)${dialect === "sqlite" ? " STRICT" : ""}`,
      apply() {
        model.tables.set(name, table);
      },
    });
  }

  function buildCreateIndex(
    name: string,
    table: string,
    columns: readonly string[],
    options: IndexOptions,
  ): BuiltStatement {
    assertIdentifier("index", name);
    assertIdentifier("table", table);
    if (model.indexes.has(name)) throw new DdlError(`index ${name} already exists`);
    for (const column of columns) assertIdentifier("column", column);
    const tableModel = model.tables.get(table);
    const tableColumns = tableModel ? new Set(tableModel.columns.map((column) => column.name)) : "any";
    assertColumnList(`index ${name}`, columns, tableColumns === "any" ? new Set(columns) : tableColumns);
    let text = `CREATE ${options.unique ? "UNIQUE " : ""}INDEX ${name} ON ${table} (${columns.join(", ")})`;
    if (options.where !== undefined) {
      assertPortableExpression(options.where, tableColumns, `index ${name} WHERE`);
      text += ` WHERE ${options.where}`;
    }
    const index: ModelIndex = Object.freeze({
      name,
      table,
      columns: Object.freeze([...columns]),
      unique: options.unique === true,
      where: options.where ?? null,
    });
    return Object.freeze({
      sql: text,
      apply() {
        model.indexes.set(name, index);
        model.tables.get(table)?.indexes.push(index);
      },
    });
  }

  function buildAddColumn(table: string, name: string, builder: Column): BuiltStatement {
    const spec = builder.spec;
    const where = `${table}.${name}`;
    assertIdentifier("table", table);
    if (spec.primaryKey || spec.unique) {
      throw new DdlError(`${where}: ADD COLUMN cannot add PRIMARY KEY or UNIQUE (SQLite)`);
    }
    if (spec.nullable === false && spec.default === undefined) {
      throw new DdlError(`${where}: a NOT NULL column added to an existing table needs a DEFAULT`);
    }
    if (spec.references && spec.nullable !== true) {
      throw new DdlError(`${where}: an added column with REFERENCES must be nullable (SQLite)`);
    }
    const tableModel = model.tables.get(table);
    if (tableModel?.columns.some((column) => column.name === name)) throw new DdlError(`${where} already exists`);
    const columns = tableModel ? new Set([...tableModel.columns.map((column) => column.name), name]) : "any";
    const column = toModelColumn(name, spec);
    const foreignKey = columnForeignKey(name, spec);
    return Object.freeze({
      sql: `ALTER TABLE ${table} ADD COLUMN ${name} ${renderColumn(table, name, spec, columns)}`,
      apply() {
        const target = model.tables.get(table);
        if (!target) return;
        target.columns.push(column);
        target.checks.push(...columnChecks(name, spec));
        if (foreignKey) target.foreignKeys.push(foreignKey);
      },
    });
  }

  return Object.freeze({
    dialect,
    types: COLUMN_TYPES,
    model,
    createTable: (name, columns, options = {}) =>
      Object.freeze({ description: `CREATE TABLE ${name}`, build: () => buildCreateTable(name, columns, options) }),
    createIndex: (name, table, columns, options = {}) =>
      Object.freeze({
        description: `CREATE INDEX ${name}`,
        build: () => buildCreateIndex(name, table, columns, options),
      }),
    addColumn: (table, name, column) =>
      Object.freeze({
        description: `ALTER TABLE ${table} ADD COLUMN ${name}`,
        build: () => buildAddColumn(table, name, column),
      }),
    async run(db: QueryExecutorProvider, ...statements: DdlStatement[]): Promise<void> {
      for (const statement of statements) {
        const built = statement.build();
        await sql.raw(built.sql).execute(db);
        built.apply();
      }
    },
    render: (statement: DdlStatement) => statement.build().sql,
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Recording executor (tooling)
// ---------------------------------------------------------------------------------------------------------------------

/** A driver that executes nothing and records the SQL text of every query. */
class RecordingDriver implements Driver {
  readonly #statements: string[];

  constructor(statements: string[]) {
    this.#statements = statements;
  }

  init(): Promise<void> {
    return Promise.resolve();
  }

  acquireConnection(): Promise<DatabaseConnection> {
    const statements = this.#statements;
    return Promise.resolve({
      executeQuery<R>(query: { sql: string }): Promise<QueryResult<R>> {
        statements.push(query.sql);
        return Promise.resolve({ rows: [] });
      },
      streamQuery(): AsyncIterableIterator<never> {
        throw new Error("the recording driver cannot stream");
      },
    });
  }

  beginTransaction(): Promise<void> {
    return Promise.resolve();
  }

  commitTransaction(): Promise<void> {
    return Promise.resolve();
  }

  rollbackTransaction(): Promise<void> {
    return Promise.resolve();
  }

  releaseConnection(): Promise<void> {
    return Promise.resolve();
  }

  destroy(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * A Kysely instance of `dialect` that records the SQL of every statement instead of running it: renders migrations
 * into `docs/schema.*.sql` without a database (`scripts/gen-schema-sql.ts`). Reads return no rows.
 */
export function recordingKysely(dialect: SqlDialect): { kysely: Kysely<unknown>; statements: string[] } {
  const statements: string[] = [];
  const kysely = new Kysely<unknown>({
    dialect: {
      createAdapter: () => (dialect === "sqlite" ? new SqliteAdapter() : new PostgresAdapter()),
      createDriver: () => new RecordingDriver(statements),
      createIntrospector: (db) => (dialect === "sqlite" ? new SqliteIntrospector(db) : new PostgresIntrospector(db)),
      createQueryCompiler: () => (dialect === "sqlite" ? new SqliteQueryCompiler() : new PostgresQueryCompiler()),
    },
  });
  return { kysely, statements };
}
