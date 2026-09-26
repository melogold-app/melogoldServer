/**
 * All migrations in order (API §9.2). Frozen from the first deployment to a live database: after that only new files
 * are added, and they only expand the schema (DESIGN §6.2). Names sort in execution order.
 */
import type { Kysely } from "kysely";
import type { Ddl } from "../ddl.ts";
import { up as core } from "./0001_core.ts";
import { up as linking } from "./0002_linking.ts";
import { up as sync } from "./0003_sync.ts";
import { up as playback } from "./0004_playback.ts";
import { up as history } from "./0005_history.ts";
import { up as lyrics } from "./0006_lyrics.ts";
import { up as overridesPins } from "./0007_overrides_pins.ts";

export type MigrationUp = (db: Kysely<unknown>, d: Ddl) => Promise<void>;

export type MelogoldMigration = Readonly<{ name: string; up: MigrationUp }>;

export const MIGRATIONS: readonly MelogoldMigration[] = Object.freeze([
  { name: "0001_core", up: core },
  { name: "0002_linking", up: linking },
  { name: "0003_sync", up: sync },
  { name: "0004_playback", up: playback },
  { name: "0005_history", up: history },
  { name: "0006_lyrics", up: lyrics },
  { name: "0007_overrides_pins", up: overridesPins },
]);
