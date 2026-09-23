/**
 * Migration runner (DESIGN §6.2, API §9.2, §9.4) over Kysely's `Migrator`:
 * - the whole run is one transaction in both dialects: PostgreSQL under Kysely's advisory lock, SQLite in one
 *   `BEGIN IMMEDIATE` (the adapter reports `supportsTransactionalDdl = true`). A failing migration leaves nothing
 *   behind;
 * - every migration gets the same `ddl(dialect)` helper, so statements see the tables created before them;
 * - **the database is newer than the code** (an image rolled back): when the database has applied migrations this
 *   code does not know and every known migration is applied, this is a warning and `migrateToLatest` is not called
 *   (Kysely would refuse with "corrupted migrations"). Unknown applied migrations with known ones still pending are an
 *   error: that database belongs to a different branch of the code;
 * - {@link prepareDatabase} is the startup sequence: `MIGRATE_ON_START`, migrations, then `SCHEMA_CHECK`.
 *
 * The migrator's tables `kysely_migration` and `kysely_migration_lock` are unqualified like every Melogold table: on
 * PostgreSQL they live in `current_schema()`, which is also the only schema the dialect's introspector looks at.
 */
import { sql } from "kysely";
import type { Kysely } from "kysely";
import { DEFAULT_MIGRATION_TABLE, Migrator } from "kysely/migration";
import type { Migration } from "kysely/migration";
import { ddl } from "./ddl.ts";
import type { SqlDialect } from "./ddl.ts";
import { MIGRATIONS } from "./migrations/index.ts";
import type { MelogoldMigration } from "./migrations/index.ts";
import { checkSchema } from "./schema-check.ts";
import type { SchemaCheckLogger, SchemaCheckResult, SchemaSnapshot } from "./schema-check.ts";
import { assertOutsideTx } from "./tx.ts";

export const MIGRATION_TABLE = DEFAULT_MIGRATION_TABLE;

/** Migrations cannot run or are not allowed to: the process exits with code 1. */
export class MigrationError extends Error {
  readonly exitCode = 1;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MigrationError";
  }
}

export type MigrationState = Readonly<{
  /** Names recorded in `kysely_migration`, sorted. */
  applied: readonly string[];
  /** Known to the code and not applied, in execution order. */
  pending: readonly string[];
  /** Applied but unknown to the code: the database is newer. */
  unknown: readonly string[];
}>;

/** A database to migrate: `ctx.db` or anything with a Kysely instance and its dialect. */
export type MigrationTarget<DB = unknown> = Readonly<{ kysely: Kysely<DB>; dialect: SqlDialect }>;

async function appliedMigrations<DB>({ kysely, dialect }: MigrationTarget<DB>): Promise<string[]> {
  const exists =
    dialect === "sqlite"
      ? await sql`SELECT 1 AS found FROM sqlite_schema WHERE type = 'table' AND name = ${MIGRATION_TABLE}`.execute(
          kysely,
        )
      : await sql`
          SELECT 1 AS found FROM information_schema.tables
          WHERE table_schema = current_schema() AND table_name = ${MIGRATION_TABLE}
        `.execute(kysely);
  if (exists.rows.length === 0) return [];
  const { rows } = await sql<{ name: string }>`SELECT name FROM ${sql.id(MIGRATION_TABLE)}`.execute(kysely);
  return rows.map((row) => row.name).sort();
}

function stateOf(applied: readonly string[], migrations: readonly MelogoldMigration[]): MigrationState {
  const known = new Set(migrations.map((migration) => migration.name));
  const done = new Set(applied);
  return Object.freeze({
    applied: Object.freeze([...applied]),
    pending: Object.freeze(migrations.map((migration) => migration.name).filter((name) => !done.has(name))),
    unknown: Object.freeze(applied.filter((name) => !known.has(name))),
  });
}

export type MigrateOptions = Readonly<{
  log: SchemaCheckLogger;
  /** Defaults to all migrations of the code (tests pass their own lists). */
  migrations?: readonly MelogoldMigration[];
}>;

/** Which migrations are applied, pending and unknown. Must run outside `db.read`/`db.write`. */
export async function readMigrationState<DB>(
  target: MigrationTarget<DB>,
  migrations: readonly MelogoldMigration[] = MIGRATIONS,
): Promise<MigrationState> {
  assertOutsideTx("migrate");
  return stateOf(await appliedMigrations(target), migrations);
}

export type MigrateResult = Readonly<
  | { status: "up_to_date"; state: MigrationState }
  | { status: "migrated"; executed: readonly string[]; state: MigrationState }
  | { status: "schema_newer"; state: MigrationState }
>;

/**
 * Applies the pending migrations in one transaction.
 * @throws MigrationError when a migration fails (nothing is applied) or the database belongs to another code branch.
 */
export async function migrateToLatest<DB>(
  target: MigrationTarget<DB>,
  options: MigrateOptions,
): Promise<MigrateResult> {
  assertOutsideTx("migrate");
  const migrations = options.migrations ?? MIGRATIONS;
  const state = stateOf(await appliedMigrations(target), migrations);
  if (state.unknown.length > 0) {
    if (state.pending.length > 0) {
      throw new MigrationError(
        `the database has migrations this version does not know (${state.unknown.join(", ")}) and lacks ` +
          `migrations it knows (${state.pending.join(", ")}): it was created by a different version of Melogold`,
      );
    }
    options.log.warn(
      { unknown: state.unknown },
      "the database schema is newer than this version (image rolled back?): migrations are skipped",
    );
    return Object.freeze({ status: "schema_newer", state });
  }
  if (state.pending.length === 0) return Object.freeze({ status: "up_to_date", state });

  const d = ddl(target.dialect);
  const resolved: Record<string, Migration> = {};
  for (const migration of migrations) resolved[migration.name] = { up: (db) => migration.up(db, d) };
  const migrator = new Migrator({
    db: target.kysely,
    provider: { getMigrations: () => Promise.resolve(resolved) },
  });
  const { error, results = [] } = await migrator.migrateToLatest();
  if (error !== undefined) {
    const failed = results.find((result) => result.status === "Error")?.migrationName;
    throw new MigrationError(
      failed === undefined
        ? "migrations could not start; nothing was applied"
        : `migration ${failed} failed; the whole run was rolled back`,
      { cause: error },
    );
  }
  const executed = results.map((result) => result.migrationName);
  // Another process took Kysely's migration lock first and applied everything we saw as pending.
  if (executed.length === 0) {
    return Object.freeze({ status: "up_to_date", state: stateOf(await appliedMigrations(target), migrations) });
  }
  return Object.freeze({
    status: "migrated",
    executed: Object.freeze(executed),
    state: stateOf([...state.applied, ...executed].sort(), migrations),
  });
}

export type PrepareDatabaseOptions = MigrateOptions &
  Readonly<{
    /** `MIGRATE_ON_START` (API §10): `false` with pending migrations → exit 1. */
    migrateOnStart: boolean;
    /** `SCHEMA_CHECK` (API §10). */
    schemaCheck: "strict" | "warn";
    snapshot?: SchemaSnapshot;
  }>;

export type PrepareDatabaseResult = Readonly<{ migration: MigrateResult; schema: SchemaCheckResult }>;

/**
 * Startup sequence before the server listens: pending migrations (or exit 1 under `MIGRATE_ON_START=false`), then the
 * schema check against the snapshot.
 * @throws MigrationError or SchemaMismatchError; both carry `exitCode = 1`.
 */
export async function prepareDatabase<DB>(
  target: MigrationTarget<DB>,
  options: PrepareDatabaseOptions,
): Promise<PrepareDatabaseResult> {
  const migrations = options.migrations ?? MIGRATIONS;
  if (!options.migrateOnStart) {
    const state = await readMigrationState(target, migrations);
    if (state.pending.length > 0 && state.unknown.length === 0) {
      throw new MigrationError(
        `MIGRATE_ON_START=false and migrations are pending (${state.pending.join(", ")}): run "migrate" first`,
      );
    }
  }
  const migration = await migrateToLatest(target, { log: options.log, migrations });
  const schema = await checkSchema(target.kysely, target.dialect, {
    mode: options.schemaCheck,
    log: options.log,
    schemaNewer: migration.status === "schema_newer",
    ...(options.snapshot ? { snapshot: options.snapshot } : {}),
  });
  return Object.freeze({ migration, schema });
}
