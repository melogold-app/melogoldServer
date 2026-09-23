/** API §9.2, 0003_sync: user mutex and cursor head, op log, library state. */
import type { Kysely } from "kysely";
import type { Ddl } from "../ddl.ts";

export async function up(db: Kysely<unknown>, d: Ddl): Promise<void> {
  const { ID, TXT, INT, BIG, TS, BOOL, JSON } = d.types;

  await d.run(
    db,
    d.createTable("sync_heads", {
      user_id: ID.notNull().primaryKey().references("users", "id", "CASCADE"),
      epoch: ID.notNull().check("length(epoch) = 8"),
      seq: BIG.notNull().default(0),
      floor_seq: BIG.notNull().default(0), // always 0 in the MVP
      updated_at: TS.notNull(),
    }),

    d.createTable(
      "sync_ops",
      {
        user_id: ID.notNull().references("users", "id", "CASCADE"),
        seq: BIG.notNull(),
        op_id: ID.notNull(),
        device_id: ID.nullable(),
        device_name: TXT.nullable(),
        kind: TXT.notNull().check("length(kind) BETWEEN 1 AND 64"),
        payload: JSON.notNull(), // without tracks
        status: TXT.notNull(), // applied | superseded | redirected | rejected
        code: TXT.nullable(),
        result: JSON.nullable(),
        client_at: TS.notNull(),
        eff_at: TS.notNull(),
        base_seq: BIG.nullable(),
        pre_image: JSON.nullable(),
        server_at: TS.notNull(),
      },
      { primaryKey: ["user_id", "seq"] },
    ),
    d.createIndex("sync_ops_op", "sync_ops", ["user_id", "op_id"], { unique: true }),
    d.createIndex("sync_ops_server_at", "sync_ops", ["server_at"]),

    d.createTable(
      "sync_tracks",
      {
        user_id: ID.notNull().references("users", "id", "CASCADE"),
        video_id: ID.notNull().check("length(video_id) = 11"),
        title: TXT.notNull(),
        artists_text: TXT.nullable(),
        artists: JSON.nullable(),
        album_id: ID.nullable(),
        album_title: TXT.nullable(),
        duration_ms: BIG.nullable(),
        duration_text: TXT.nullable(),
        thumbnail_url: TXT.nullable(),
        explicit: BOOL.notNull().default(0),
        video_type: TXT.nullable(),
        stub: BOOL.notNull().default(0),
        seq: BIG.notNull(),
        updated_at: TS.notNull(),
      },
      { primaryKey: ["user_id", "video_id"] },
    ),
    d.createIndex("sync_tracks_pull", "sync_tracks", ["user_id", "seq"]),

    d.createTable(
      "sync_likes",
      {
        user_id: ID.notNull().references("users", "id", "CASCADE"),
        video_id: ID.notNull().check("length(video_id) = 11"),
        liked: BOOL.notNull(),
        liked_at: TS.nullable(),
        seq: BIG.notNull(),
        clk_at: TS.notNull(),
        clk_dev: ID.nullable(),
      },
      { primaryKey: ["user_id", "video_id"] },
    ),
    d.createIndex("sync_likes_pull", "sync_likes", ["user_id", "seq"]),

    d.createTable(
      "sync_bookmarks",
      {
        user_id: ID.notNull().references("users", "id", "CASCADE"),
        type: ID.notNull().check("length(type) BETWEEN 1 AND 16"), // album | artist
        browse_id: ID.notNull().check("length(browse_id) BETWEEN 1 AND 64"),
        bookmarked: BOOL.notNull(),
        bookmarked_at: TS.nullable(),
        title: TXT.nullable(),
        subtitle: TXT.nullable(),
        thumbnail_url: TXT.nullable(),
        year: TXT.nullable(),
        seq: BIG.notNull(),
        clk_at: TS.notNull(),
        clk_dev: ID.nullable(),
      },
      { primaryKey: ["user_id", "type", "browse_id"] },
    ),
    d.createIndex("sync_bookmarks_pull", "sync_bookmarks", ["user_id", "seq"]),

    d.createTable(
      "sync_playlists",
      {
        user_id: ID.notNull().references("users", "id", "CASCADE"),
        id: ID.notNull(),
        name: TXT.notNull().check("length(name) BETWEEN 1 AND 200"),
        browse_id: ID.nullable(),
        thumbnail_url: TXT.nullable(),
        created_at: TS.notNull(),
        deleted: BOOL.notNull().default(0),
        deleted_at: TS.nullable(),
        deleted_seq: BIG.nullable(),
        item_count: INT.notNull().default(0), // present items; quota; does not move seq
        seq: BIG.notNull(),
        clk_at: TS.notNull(),
        clk_dev: ID.nullable(),
      },
      { primaryKey: ["user_id", "id"] },
    ),
    d.createIndex("sync_playlists_pull", "sync_playlists", ["user_id", "seq"]),
    d.createIndex("sync_playlists_live_browse", "sync_playlists", ["user_id", "browse_id"], {
      where: "deleted = 0 AND browse_id IS NOT NULL",
    }),

    d.createTable(
      "sync_playlist_items",
      {
        user_id: ID.notNull(),
        playlist_id: ID.notNull(),
        video_id: ID.notNull().check("length(video_id) = 11"),
        present: BOOL.notNull(),
        sort_key: ID.notNull().check("length(sort_key) BETWEEN 1 AND 64"),
        added_at: TS.notNull(),
        seq: BIG.notNull(), // = max(mem_seq, pos_seq)
        mem_seq: BIG.notNull(),
        mem_at: TS.notNull(),
        mem_dev: ID.nullable(),
        pos_seq: BIG.notNull(),
        pos_at: TS.notNull(),
        pos_dev: ID.nullable(),
      },
      {
        primaryKey: ["user_id", "playlist_id", "video_id"],
        foreignKeys: [
          {
            columns: ["user_id", "playlist_id"],
            table: "sync_playlists",
            references: ["user_id", "id"],
            onDelete: "CASCADE",
          },
        ],
      },
    ),
    d.createIndex("sync_items_pull", "sync_playlist_items", ["user_id", "seq"]),
    d.createIndex("sync_items_order", "sync_playlist_items", ["user_id", "playlist_id", "sort_key", "video_id"], {
      where: "present = 1",
    }),
  );
}
