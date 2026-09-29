/**
 * API §9.2, 0008_shares_remote: snapshots of own playlists by link (§4.11) and the volume a device reports for remote
 * control (§4.9).
 */
import type { Kysely } from "kysely";
import type { Ddl } from "../ddl.ts";

export async function up(db: Kysely<unknown>, d: Ddl): Promise<void> {
  const { ID, TXT, INT, TS, JSON } = d.types;

  await d.run(
    db,
    d.createTable("shares", {
      id: ID.notNull().primaryKey().check("length(id) = 10"),
      user_id: ID.notNull().references("users", "id", "CASCADE"),
      kind: TXT.notNull(), // playlist
      name: TXT.notNull(),
      tracks: JSON.notNull(), // TrackDto[]
      created_at: TS.notNull(),
    }),
    d.createIndex("shares_user", "shares", ["user_id", "created_at"]),
    d.addColumn("playback_state", "volume", INT.nullable()), // 0..100
  );
}
