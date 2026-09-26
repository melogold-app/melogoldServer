/**
 * API §9.2, 0007_overrides_pins: the user's own text over the YouTube metadata of a track (`track.override.set`) and
 * pinned lyrics found automatically (`lyrics.pin.set`). Both are LWW registers of the library stream with a tombstone.
 */
import type { Kysely } from "kysely";
import type { Ddl } from "../ddl.ts";

export async function up(db: Kysely<unknown>, d: Ddl): Promise<void> {
  const { ID, TXT, INT, BIG, TS, BOOL } = d.types;

  await d.run(
    db,
    d.createTable(
      "sync_track_overrides",
      {
        user_id: ID.notNull().references("users", "id", "CASCADE"),
        video_id: ID.notNull().check("length(video_id) = 11"),
        title: TXT.nullable(),
        artists_text: TXT.nullable(),
        album_title: TXT.nullable(),
        updated_at: TS.notNull(),
        seq: BIG.notNull(),
        deleted: BOOL.notNull(),
        clk_at: TS.notNull(),
        clk_dev: ID.nullable(),
      },
      { primaryKey: ["user_id", "video_id"] },
    ),
    d.createIndex("sync_track_overrides_pull", "sync_track_overrides", ["user_id", "seq"]),

    d.createTable(
      "sync_lyrics_pins",
      {
        user_id: ID.notNull().references("users", "id", "CASCADE"),
        video_id: ID.notNull().check("length(video_id) = 11"),
        source: TXT.nullable(), // youtube_music | lrclib | kugou
        ref: TXT.nullable(),
        start_time_ms: INT.nullable(),
        updated_at: TS.notNull(),
        seq: BIG.notNull(),
        deleted: BOOL.notNull(),
        clk_at: TS.notNull(),
        clk_dev: ID.nullable(),
      },
      { primaryKey: ["user_id", "video_id"] },
    ),
    d.createIndex("sync_lyrics_pins_pull", "sync_lyrics_pins", ["user_id", "seq"]),
  );
}
