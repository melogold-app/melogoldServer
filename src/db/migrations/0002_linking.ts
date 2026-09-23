/** API §9.2, 0002_linking: device linking by QR or code through the server. */
import type { Kysely } from "kysely";
import type { Ddl } from "../ddl.ts";

export async function up(db: Kysely<unknown>, d: Ddl): Promise<void> {
  const { ID, TXT, TS } = d.types;

  await d.run(
    db,
    d.createTable("device_links", {
      id: ID.notNull().primaryKey(),
      mode: TXT.notNull(), // request | invite
      status: TXT.notNull(), // pending | claimed | approved | denied | cancelled | completed
      token_hash: ID.notNull().unique(),
      code_hash: ID.notNull().unique(),
      poll_secret_hash: ID.nullable().unique(),
      user_id: ID.nullable().references("users", "id", "CASCADE"),
      approver_device_id: ID.nullable().references("devices", "id", "SET NULL"),
      claimant_hwid_hash: ID.nullable(),
      claimant_name: TXT.nullable(),
      claimant_platform: TXT.nullable(),
      claimant_os_version: TXT.nullable(),
      claimant_model: TXT.nullable(),
      claimant_client_version: TXT.nullable(),
      verify_code: TXT.nullable().check("verify_code IS NULL OR length(verify_code) = 2"),
      deny_reason: TXT.nullable(), // user | verify_mismatch
      creator_net: TXT.nullable(), // IPv4 or IPv6/56; erased in a final status
      other_net: TXT.nullable(),
      result_device_id: ID.nullable(), // no FK
      result_refresh_id: ID.nullable(), // no FK; repeated poll (60 s)
      created_at: TS.notNull(),
      expires_at: TS.notNull(),
      claimed_at: TS.nullable(),
      decided_at: TS.nullable(),
      completed_at: TS.nullable(),
    }),
    d.createIndex("device_links_expires", "device_links", ["expires_at"]),
    d.createIndex("device_links_user", "device_links", ["user_id"]),
    d.createIndex("device_links_approver", "device_links", ["approver_device_id"]),
    d.createIndex("device_links_net", "device_links", ["creator_net"], { where: "creator_net IS NOT NULL" }),
  );
}
