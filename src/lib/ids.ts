/**
 * Identifiers (API §1.6, §8; DESIGN §3.2).
 *
 * - Every id the server creates is a random UUID v4 in lowercase ({@link newId}); SQL never generates ids.
 * - {@link uuidv5} (RFC 9562 §5.5: SHA-1 of namespace bytes followed by the UTF-8 name) gives deterministic ids: the
 *   recovery playlist is `uuidv5(<id of the deleted playlist>, NS_MELOGOLD_RECOVERY)`, so every device that recovers
 *   the same playlist arrives at the same id.
 */
import { createHash, randomUUID } from "node:crypto";

/** API §1.6 `Uuid`: lowercase only. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Namespace of recovery playlist ids (API §8). Chosen once, never changes. */
export const NS_MELOGOLD_RECOVERY = "cf3e0fee-fe4e-42a1-b392-e5ffb8933b87";

/** A new random UUID v4, lowercase. */
export function newId(): string {
  return randomUUID();
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

const ANY_CASE_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function uuidBytes(uuid: string): Buffer {
  if (!ANY_CASE_UUID.test(uuid)) throw new TypeError(`not a UUID: "${uuid}"`);
  return Buffer.from(uuid.replaceAll("-", ""), "hex");
}

function formatUuid(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Name-based UUID v5 (RFC 9562 §5.5). The name is hashed as UTF-8; the result is lowercase.
 * @param name any string, e.g. a playlist id.
 * @param namespace a UUID in any case.
 */
export function uuidv5(name: string, namespace: string): string {
  const digest = createHash("sha1").update(uuidBytes(namespace)).update(name, "utf8").digest();
  const bytes = digest.subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50; // version 5
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // RFC 9562 variant
  return formatUuid(bytes);
}

/** Id of the recovery playlist for a deleted playlist (DESIGN §3.2, §3.7). */
export function recoveryPlaylistId(deletedPlaylistId: string): string {
  return uuidv5(deletedPlaylistId, NS_MELOGOLD_RECOVERY);
}
