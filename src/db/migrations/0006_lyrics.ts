/** API §9.2, 0006_lyrics: one version of the lyrics of a track per user (API §4.10). */
import type { Kysely } from "kysely";
import type { Ddl } from "../ddl.ts";

export async function up(db: Kysely<unknown>, d: Ddl): Promise<void> {
  const { ID, TXT, BIG, TS, BOOL } = d.types;

  await d.run(
    db,
    d.createTable("lyrics", {
      id: ID.notNull().primaryKey(),
      user_id: ID.notNull().references("users", "id", "CASCADE"),
      video_id: ID.notNull().check("length(video_id) = 11"),
      rev: BIG.notNull().check("rev >= 1"), // the user's change counter
      deleted: BOOL.notNull().default(0), // tombstone of DELETE
      plain: TXT.nullable(),
      plain_source: TXT.nullable(),
      synced: TXT.nullable(),
      synced_format: TXT.nullable(), // lrc | ttml
      synced_source: TXT.nullable(),
      start_time_ms: BIG.nullable(),
      language: TXT.nullable(),
      created_at: TS.notNull(),
      updated_at: TS.notNull(),
    }),
    d.createIndex("lyrics_user_video", "lyrics", ["user_id", "video_id"], { unique: true }),
    d.createIndex("lyrics_user_rev", "lyrics", ["user_id", "rev"], { unique: true }),
    d.createIndex("lyrics_video", "lyrics", ["video_id", "updated_at"]),
  );
}
