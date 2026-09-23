/** API §9.2, 0001_core: server metadata, users, devices, refresh tokens, login throttling. */
import type { Kysely } from "kysely";
import type { Ddl } from "../ddl.ts";

export async function up(db: Kysely<unknown>, d: Ddl): Promise<void> {
  const { ID, TXT, INT, TS } = d.types;

  await d.run(
    db,
    d.createTable("server_meta", {
      // server_id | created_at | first_user_id | restore_pending | restore_refresh_grace_until
      key: ID.notNull().primaryKey(),
      value: TXT.notNull(),
    }),

    d.createTable("users", {
      id: ID.notNull().primaryKey(),
      // normalized; a deleted account gets '!deleted:' || id
      login: ID.notNull().unique().check("length(login) BETWEEN 3 AND 64"),
      password_hash: TXT.notNull(), // PHC argon2id
      auth_version: INT.notNull().default(1),
      password_changed_at: TS.notNull(),
      recovery_code_hash: ID.notNull().check("length(recovery_code_hash) = 64"),
      recovery_code_created_at: TS.notNull(),
      recovery_code_confirmed_at: TS.nullable(),
      created_by: TXT.notNull().default("self"), // self | admin
      deleted_at: TS.nullable(),
      created_at: TS.notNull(),
      updated_at: TS.notNull(),
    }),
    d.createIndex("users_deleted", "users", ["deleted_at"], { where: "deleted_at IS NOT NULL" }),

    d.createTable(
      "devices",
      {
        id: ID.notNull().primaryKey(),
        user_id: ID.notNull().references("users", "id", "CASCADE"),
        hwid_hash: ID.notNull().check("length(hwid_hash) = 64"),
        reported_name: TXT.notNull().check("length(reported_name) BETWEEN 1 AND 64"),
        custom_name: TXT.nullable().check("custom_name IS NULL OR length(custom_name) BETWEEN 1 AND 64"),
        platform: TXT.notNull().check("length(platform) BETWEEN 1 AND 16"),
        os_version: TXT.nullable(),
        model: TXT.nullable(),
        client_version: TXT.nullable(),
        linked_via: TXT.notNull(), // register | login | link | recovery
        linked_by_device_id: ID.nullable(), // no FK
        created_at: TS.notNull(),
        last_seen_at: TS.notNull(),
        last_sync_at: TS.nullable(),
      },
      { unique: [["user_id", "hwid_hash"]] },
    ),
    d.createIndex("devices_last_seen", "devices", ["last_seen_at"]),

    d.createTable("refresh_tokens", {
      id: ID.notNull().primaryKey(), // = tid
      user_id: ID.notNull().references("users", "id", "CASCADE"),
      device_id: ID.notNull().references("devices", "id", "CASCADE"),
      token_hash: ID.notNull().unique(), // sha256(token)
      expires_at: TS.notNull(),
      rotated_to_id: ID.nullable(),
      rotation_grace_expires_at: TS.nullable(),
      revoked_at: TS.nullable(),
      confirmed_at: TS.nullable(), // first use of an access token with rid = id
      created_at: TS.notNull(),
    }),
    d.createIndex("refresh_tokens_user", "refresh_tokens", ["user_id"]),
    d.createIndex("refresh_tokens_device", "refresh_tokens", ["device_id"]),
    d.createIndex("refresh_tokens_expires", "refresh_tokens", ["expires_at"]),

    d.createTable(
      "auth_throttle",
      {
        scope: ID.notNull(), // login | reauth
        key_hash: ID.notNull(), // sha256(scope + ":" + key)
        failures: INT.notNull().default(0),
        window_start: TS.notNull(),
        locked_until: TS.nullable(),
        updated_at: TS.notNull(),
      },
      { primaryKey: ["scope", "key_hash"] },
    ),
  );
}
