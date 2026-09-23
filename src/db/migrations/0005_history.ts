/** API §9.2, 0005_history: listening events, per-track totals and forget watermarks. */
import type { Kysely } from "kysely";
import type { Ddl } from "../ddl.ts";

export async function up(db: Kysely<unknown>, d: Ddl): Promise<void> {
  const { ID, INT, BIG, TS, BOOL } = d.types;

  await d.run(
    db,
    d.createTable(
      "play_events",
      {
        user_id: ID.notNull().references("users", "id", "CASCADE"),
        event_id: ID.notNull(),
        video_id: ID.notNull().check("length(video_id) = 11"),
        played_at: TS.notNull(),
        play_time_ms: INT.notNull().check("play_time_ms BETWEEN 1 AND 86400000"),
        in_history: BOOL.notNull(),
        counts_playtime: BOOL.notNull(),
        device_id: ID.nullable(),
        seq: BIG.nullable(), // only when in_history = 1
        received_at: TS.notNull(),
      },
      { primaryKey: ["user_id", "event_id"] },
    ),
    d.createIndex("play_events_pull", "play_events", ["user_id", "seq"], { where: "seq IS NOT NULL" }),
    d.createIndex("play_events_video", "play_events", ["user_id", "video_id", "played_at"]),
    d.createIndex("play_events_time", "play_events", ["user_id", "played_at"]),
    d.createIndex("play_events_recv", "play_events", ["user_id", "received_at"]), // play.add limit per hour
    d.createIndex("play_events_idem", "play_events", ["received_at"], { where: "in_history = 0" }),

    d.createTable(
      "play_stats",
      {
        user_id: ID.notNull().references("users", "id", "CASCADE"),
        video_id: ID.notNull().check("length(video_id) = 11"),
        total_ms: BIG.notNull().default(0),
        last_played_at: TS.nullable(),
        seq: BIG.notNull(),
      },
      { primaryKey: ["user_id", "video_id"] },
    ),
    d.createIndex("play_stats_pull", "play_stats", ["user_id", "seq"]),

    d.createTable(
      "play_forgets",
      {
        user_id: ID.notNull().references("users", "id", "CASCADE"),
        video_id: ID.notNull().check("video_id = '*' OR length(video_id) = 11"),
        events_before: TS.notNull(),
        total_before: TS.nullable(),
        seq: BIG.notNull(),
      },
      { primaryKey: ["user_id", "video_id"] },
    ),
    d.createIndex("play_forgets_pull", "play_forgets", ["user_id", "seq"]),
  );
}
