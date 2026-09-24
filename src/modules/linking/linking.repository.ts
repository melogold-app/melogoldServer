/**
 * SQL of the `linking` module (API §9.2 `0002_linking`, DESIGN §4.10). Every function takes the caller's `q` and
 * opens no transaction (docs/database.md §2.1).
 *
 * - Links are created with `INSERT … ON CONFLICT DO NOTHING RETURNING id`: a collision of `token_hash`, `code_hash`
 *   or `poll_secret_hash` returns no row and the service draws new secrets; no constraint error is ever caught
 *   inside a transaction (M11).
 * - Every status change is a CAS (`UPDATE … WHERE status IN (…) AND expires_at > now`, docs/database.md §2.6): the
 *   caller checks whether a row changed. A final status (`denied`, `cancelled`, `completed`) erases the network hints
 *   and what the new device reported about itself (API §4.6: `creator_net`, `other_net`, `claimant_*`).
 * - `expired` is never written: it is `expires_at <= now` of an unfinished link, computed by the service.
 *
 * Completing a link creates the new device and its session (DESIGN §4.10.6), so this module also reads `users`,
 * reads and upserts `devices` and reads `refresh_tokens` (the repeated poll re-signs its refresh token); the refresh
 * token itself is inserted by `issueSession` (`src/lib/session.ts`).
 */
import type { Insertable, Selectable } from "kysely";
import type { Queryable } from "../../db/index.ts";
import type { DeviceLinksTable, DevicesTable, RefreshTokensTable, UsersTable } from "../../db/types.ts";
import { UNFINISHED_LINK_STATUSES } from "../../lib/device-removal.ts";

export type LinkRow = Selectable<DeviceLinksTable>;
export type NewLinkRow = Insertable<DeviceLinksTable>;
export type DeviceRow = Selectable<DevicesTable>;
export type RefreshTokenRow = Selectable<RefreshTokensTable>;
export type UserRow = Pick<
  Selectable<UsersTable>,
  | "id"
  | "login"
  | "auth_version"
  | "password_changed_at"
  | "recovery_code_created_at"
  | "recovery_code_confirmed_at"
  | "created_at"
>;

/** Link statuses that are stored (API §9.2); `expired` is computed. */
export type StoredLinkStatus = "pending" | "claimed" | "approved" | "denied" | "cancelled" | "completed";
export type UnfinishedLinkStatus = (typeof UNFINISHED_LINK_STATUSES)[number];

/** `device_links.deny_reason`. */
export type DenyReason = "user" | "verify_mismatch";

/** The columns a final status erases (API §4.6 "Прочее"). */
const ERASED_IN_FINAL_STATUS = {
  creator_net: null,
  other_net: null,
  claimant_hwid_hash: null,
  claimant_name: null,
  claimant_platform: null,
  claimant_os_version: null,
  claimant_model: null,
  claimant_client_version: null,
} as const;

// ---------------------------------------------------------------------------------------------------------------------
// device_links: reading
// ---------------------------------------------------------------------------------------------------------------------

export function findLinkById(q: Queryable, id: string): Promise<LinkRow | undefined> {
  return q.selectFrom("device_links").selectAll().where("id", "=", id).executeTakeFirst();
}

/** By `sha256(linkToken)`. */
export function findLinkByTokenHash(q: Queryable, tokenHash: string): Promise<LinkRow | undefined> {
  return q.selectFrom("device_links").selectAll().where("token_hash", "=", tokenHash).executeTakeFirst();
}

/** By `sha256(userCode)` of the normalized code (8 characters, no separator). */
export function findLinkByCodeHash(q: Queryable, codeHash: string): Promise<LinkRow | undefined> {
  return q.selectFrom("device_links").selectAll().where("code_hash", "=", codeHash).executeTakeFirst();
}

/** By `sha256(pollSecret)`. */
export function findLinkByPollSecretHash(q: Queryable, pollSecretHash: string): Promise<LinkRow | undefined> {
  return q.selectFrom("device_links").selectAll().where("poll_secret_hash", "=", pollSecretHash).executeTakeFirst();
}

export type ActiveRequests = Readonly<{ count: number; oldestExpiresAt: number | null }>;

/**
 * Unfinished, unexpired `request` links created from the network `net` (API §1.10: at most 20 per IP). A final
 * status erases `creator_net`, so only unfinished links can match.
 */
export async function countActiveRequestsFromNet(q: Queryable, net: string, now: number): Promise<ActiveRequests> {
  const row = await q
    .selectFrom("device_links")
    .select((eb) => [eb.fn.countAll<number>().as("count"), eb.fn.min<number | null>("expires_at").as("oldest")])
    .where("creator_net", "=", net)
    .where("mode", "=", "request")
    .where("status", "in", UNFINISHED_LINK_STATUSES)
    .where("expires_at", ">", now)
    .executeTakeFirstOrThrow();
  return { count: row.count, oldestExpiresAt: row.oldest };
}

/** Unfinished, unexpired invites of the user, oldest first (API §4.6: a fourth active invite cancels the oldest). */
export function listActiveInvites(
  q: Queryable,
  userId: string,
  now: number,
): Promise<Pick<LinkRow, "id" | "approver_device_id" | "created_at">[]> {
  return q
    .selectFrom("device_links")
    .select(["id", "approver_device_id", "created_at"])
    .where("user_id", "=", userId)
    .where("mode", "=", "invite")
    .where("status", "in", UNFINISHED_LINK_STATUSES)
    .where("expires_at", ">", now)
    .orderBy("created_at")
    .orderBy("id")
    .execute();
}

// ---------------------------------------------------------------------------------------------------------------------
// device_links: writing
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Inserts a new link unless one of its unique secrets (`id`, `token_hash`, `code_hash`, `poll_secret_hash`) is
 * taken: `ON CONFLICT DO NOTHING RETURNING id`.
 * @returns whether the row was inserted.
 */
export async function insertLink(q: Queryable, row: NewLinkRow): Promise<boolean> {
  const inserted = await q
    .insertInto("device_links")
    .values(row)
    .onConflict((conflict) => conflict.doNothing())
    .returning("id")
    .executeTakeFirst();
  return inserted !== undefined;
}

/** What the new device reports about itself (`claimant_*`) plus the secrets drawn when a link is claimed. */
export type ClaimPatch = Readonly<{
  userId: string;
  approverDeviceId: string;
  verifyCode: string;
  otherNet: string | null;
  /** Invite: the poll secret handed to the new device now; request: already set at creation. */
  pollSecretHash?: string;
  /** Invite: the new device's report; request: already set at creation. */
  claimant?: Readonly<{
    hwidHash: string;
    name: string;
    platform: string;
    osVersion: string | null;
    model: string | null;
    clientVersion: string | null;
  }>;
}>;

/**
 * CAS `pending → claimed` of an unexpired link (resolve in `request` mode, claim in `invite` mode).
 * @returns the claimed row, or `undefined` when the link is no longer pending (another side won the race).
 */
export function claimLink(q: Queryable, linkId: string, patch: ClaimPatch, now: number): Promise<LinkRow | undefined> {
  return q
    .updateTable("device_links")
    .set({
      status: "claimed",
      user_id: patch.userId,
      approver_device_id: patch.approverDeviceId,
      verify_code: patch.verifyCode,
      other_net: patch.otherNet,
      claimed_at: now,
      ...(patch.pollSecretHash === undefined ? {} : { poll_secret_hash: patch.pollSecretHash }),
      ...(patch.claimant === undefined
        ? {}
        : {
            claimant_hwid_hash: patch.claimant.hwidHash,
            claimant_name: patch.claimant.name,
            claimant_platform: patch.claimant.platform,
            claimant_os_version: patch.claimant.osVersion,
            claimant_model: patch.claimant.model,
            claimant_client_version: patch.claimant.clientVersion,
          }),
    })
    .where("id", "=", linkId)
    .where("status", "=", "pending")
    .where("expires_at", ">", now)
    .returningAll()
    .executeTakeFirst();
}

/**
 * CAS `claimed → approved` by the approving device of an unexpired link.
 * @returns whether the link changed.
 */
export async function approveLink(
  q: Queryable,
  linkId: string,
  approverDeviceId: string,
  now: number,
): Promise<boolean> {
  const result = await q
    .updateTable("device_links")
    .set({ status: "approved", decided_at: now })
    .where("id", "=", linkId)
    .where("status", "=", "claimed")
    .where("approver_device_id", "=", approverDeviceId)
    .where("expires_at", ">", now)
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

/**
 * CAS `from → denied` of an unexpired link; erases the data of the final status.
 * @returns whether the link changed.
 */
export async function denyLink(
  q: Queryable,
  linkId: string,
  reason: DenyReason,
  from: readonly UnfinishedLinkStatus[],
  now: number,
): Promise<boolean> {
  if (from.length === 0) return false;
  const result = await q
    .updateTable("device_links")
    .set({ status: "denied", deny_reason: reason, decided_at: now, ...ERASED_IN_FINAL_STATUS })
    .where("id", "=", linkId)
    .where("status", "in", from)
    .where("expires_at", ">", now)
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

/**
 * CAS `unfinished → cancelled` of unexpired links (at most 1000 ids, the caller's own lists are tiny); erases the
 * data of the final status.
 * @returns the links that changed, with their approving device.
 */
export async function cancelLinks(
  q: Queryable,
  linkIds: readonly string[],
  now: number,
): Promise<Pick<LinkRow, "id" | "user_id" | "approver_device_id">[]> {
  if (linkIds.length === 0) return [];
  return q
    .updateTable("device_links")
    .set({ status: "cancelled", decided_at: now, ...ERASED_IN_FINAL_STATUS })
    .where("id", "in", linkIds)
    .where("status", "in", UNFINISHED_LINK_STATUSES)
    .where("expires_at", ">", now)
    .returning(["id", "user_id", "approver_device_id"])
    .execute();
}

/**
 * Step 1 of the completion (DESIGN §4.10.6): CAS `approved → completed` of the user's unexpired link. The row comes
 * back as it was **before** erasing, because the device is created from `claimant_*` in the same transaction;
 * {@link setLinkResult} erases them.
 * @returns the completed row, or `undefined` when the link is not approved (any more).
 */
export function completeLink(q: Queryable, linkId: string, userId: string, now: number): Promise<LinkRow | undefined> {
  return q
    .updateTable("device_links")
    .set({ status: "completed", completed_at: now })
    .where("id", "=", linkId)
    .where("user_id", "=", userId)
    .where("status", "=", "approved")
    .where("expires_at", ">", now)
    .returningAll()
    .executeTakeFirst();
}

/** Last step of the completion: the result for the repeated poll (m3) and the erasure of the final status. */
export async function setLinkResult(
  q: Queryable,
  linkId: string,
  resultDeviceId: string,
  resultRefreshId: string,
): Promise<void> {
  await q
    .updateTable("device_links")
    .set({ result_device_id: resultDeviceId, result_refresh_id: resultRefreshId, ...ERASED_IN_FINAL_STATUS })
    .where("id", "=", linkId)
    .execute();
}

/**
 * Turns a link this transaction has just completed into `cancelled`: its approving device is gone (DESIGN §4.10.6
 * step 2). Only called after {@link completeLink} succeeded in the same transaction.
 */
export async function cancelCompletedLink(q: Queryable, linkId: string, now: number): Promise<void> {
  await q
    .updateTable("device_links")
    .set({ status: "cancelled", decided_at: now, completed_at: null, ...ERASED_IN_FINAL_STATUS })
    .where("id", "=", linkId)
    .where("status", "=", "completed")
    .execute();
}

// ---------------------------------------------------------------------------------------------------------------------
// Other tables the link flow reads or writes
// ---------------------------------------------------------------------------------------------------------------------

/** A user that is not deleted. */
export function findUser(q: Queryable, userId: string): Promise<UserRow | undefined> {
  return q
    .selectFrom("users")
    .select([
      "id",
      "login",
      "auth_version",
      "password_changed_at",
      "recovery_code_created_at",
      "recovery_code_confirmed_at",
      "created_at",
    ])
    .where("id", "=", userId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
}

export function findDevice(q: Queryable, userId: string, deviceId: string): Promise<DeviceRow | undefined> {
  return q
    .selectFrom("devices")
    .selectAll()
    .where("id", "=", deviceId)
    .where("user_id", "=", userId)
    .executeTakeFirst();
}

/** The user's device with this `sha256(hwid)`, if any (`alreadyLinked`, reuse on completion). */
export async function findDeviceIdByHwid(q: Queryable, userId: string, hwidHash: string): Promise<string | undefined> {
  const row = await q
    .selectFrom("devices")
    .select("id")
    .where("user_id", "=", userId)
    .where("hwid_hash", "=", hwidHash)
    .executeTakeFirst();
  return row?.id;
}

export async function countDevices(q: Queryable, userId: string): Promise<number> {
  const row = await q
    .selectFrom("devices")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("user_id", "=", userId)
    .executeTakeFirstOrThrow();
  return row.count;
}

export type LinkedDeviceInput = Readonly<{
  /** Id of a new row; an existing `(user_id, hwid_hash)` row keeps its own id. */
  id: string;
  userId: string;
  hwidHash: string;
  reportedName: string;
  platform: string;
  osVersion: string | null;
  model: string | null;
  clientVersion: string | null;
  linkedByDeviceId: string;
  now: number;
}>;

/**
 * Step 4 of the completion: `INSERT … ON CONFLICT (user_id, hwid_hash) DO UPDATE … RETURNING *` with
 * `linked_via = 'link'`. A device the account already had with this hwid is reused: it keeps its id, custom name and
 * last sync, and takes the report, `linked_by_device_id` and `created_at = now` of this link, so it is "new"
 * (`recent`, DESIGN §4.8) like any device a link creates.
 */
export function upsertLinkedDevice(q: Queryable, input: LinkedDeviceInput): Promise<DeviceRow> {
  return q
    .insertInto("devices")
    .values({
      id: input.id,
      user_id: input.userId,
      hwid_hash: input.hwidHash,
      reported_name: input.reportedName,
      custom_name: null,
      platform: input.platform,
      os_version: input.osVersion,
      model: input.model,
      client_version: input.clientVersion,
      linked_via: "link",
      linked_by_device_id: input.linkedByDeviceId,
      created_at: input.now,
      last_seen_at: input.now,
      last_sync_at: null,
    })
    .onConflict((conflict) =>
      conflict.columns(["user_id", "hwid_hash"]).doUpdateSet((eb) => ({
        reported_name: eb.ref("excluded.reported_name"),
        platform: eb.ref("excluded.platform"),
        os_version: eb.ref("excluded.os_version"),
        model: eb.ref("excluded.model"),
        client_version: eb.ref("excluded.client_version"),
        linked_via: eb.ref("excluded.linked_via"),
        linked_by_device_id: eb.ref("excluded.linked_by_device_id"),
        created_at: eb.ref("excluded.created_at"),
        last_seen_at: eb.ref("excluded.last_seen_at"),
      })),
    )
    .returningAll()
    .executeTakeFirstOrThrow();
}

export function findRefreshToken(q: Queryable, id: string): Promise<RefreshTokenRow | undefined> {
  return q.selectFrom("refresh_tokens").selectAll().where("id", "=", id).executeTakeFirst();
}
