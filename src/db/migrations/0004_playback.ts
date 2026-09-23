/** API §9.2, 0004_playback: one "continue on another device" row per user. */
import type { Kysely } from "kysely";
import type { Ddl } from "../ddl.ts";

export async function up(db: Kysely<unknown>, d: Ddl): Promise<void> {
  const { ID, TXT, INT, BIG, TS, BOOL, JSON } = d.types;

  await d.run(
    db,
    d.createTable("playback_state", {
      user_id: ID.notNull().primaryKey().references("users", "id", "CASCADE"),
      rev: BIG.notNull(),
      cleared: BOOL.notNull().default(0), // tombstone of DELETE
      device_id: ID.notNull(), // no FK
      device_name: TXT.nullable(),
      session_id: ID.notNull(),
      queue_version: BIG.notNull().check("queue_version >= 0"),
      queue: JSON.notNull(), // [TrackDto] ≤ 200; '[]' when cleared
      idx: INT.notNull().check("idx >= 0"),
      position_ms: BIG.notNull().check("position_ms >= 0"),
      duration_ms: BIG.nullable(),
      playing: BOOL.notNull(),
      state_at: TS.notNull(),
      updated_at: TS.notNull(),
      handoff_device_id: ID.nullable(),
      handoff_session_id: ID.nullable(),
      handoff_at: TS.nullable(),
    }),
    d.createIndex("playback_state_updated", "playback_state", ["updated_at"]),
  );
}
