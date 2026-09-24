/**
 * `POST /sync/merge-plan` (API §4.7, DESIGN §3.14): a pure function, nothing is written. Matches every local
 * playlist of the request to a server playlist of the user in five passes, in the order below; a server playlist is
 * claimed by at most one entry, and a claim from an earlier pass is never revisited.
 *
 * 1. `syncId` names a live, unclaimed server playlist → `merge`.
 * 2. `syncId` names a deleted server playlist → `deleted` (claims nothing: several locals may share one tombstone).
 * 3. `browseId`: exactly one live, unclaimed server playlist and exactly one still-unresolved local entry share it
 *    → `merge`.
 * 4. Same rule over `norm(name)` (`NFKC`, trimmed, internal whitespace collapsed, lower-cased) of what pass 3 left
 *    unresolved and unclaimed.
 * 5. Otherwise `create`: the request's `syncId` becomes the new id when the server has never heard of it, live or
 *    deleted; otherwise a fresh random `Uuid`, so two entries never create the same id.
 *
 * {@link computeMergePlan} is the pure algorithm (its vectors, if any, would sit beside the client ports); {@link
 * planMerge} is the one line that reads the user's playlists for it.
 */
import { newId } from "../../../lib/ids.ts";
import type {
  MergeAction,
  MergePlanEntry,
  MergePlanInput,
  MergePlanRequest,
  MergePlanResponse,
} from "../../../contract/sync.ts";
import type { Queryable } from "../../../db/index.ts";

/** A playlist of the user as the merge plan needs it: live or deleted, `id` always the server's `Uuid`. */
export type ServerPlaylistSummary = Readonly<{ id: string; name: string; browseId: string | null; deleted: boolean }>;

/** `norm(s)` of API §4.7: two names collide when they differ only by case, NFKC composition or run of whitespace. */
export function normalizePlaylistName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string | null): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    if (key === null) continue;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

type Entry = (localKey: string, action: MergeAction, playlistId: string, serverName: string | null) => void;

/**
 * Pass 3 or 4: a local entry and a server playlist merge when each is the only one left holding a given key
 * (`browseId`, then `norm(name)`). Mutates `claimed` and reports matches through `entry`.
 */
function matchOneToOne(
  locals: readonly MergePlanInput[],
  freeServers: readonly ServerPlaylistSummary[],
  localKeyOf: (local: MergePlanInput) => string | null,
  serverKeyOf: (playlist: ServerPlaylistSummary) => string | null,
  claimed: Set<string>,
  entry: Entry,
): void {
  const localGroups = groupBy(locals, localKeyOf);
  const serverGroups = groupBy(freeServers, serverKeyOf);
  for (const [key, group] of localGroups) {
    if (group.length !== 1) continue;
    const serverGroup = serverGroups.get(key);
    if (serverGroup?.length !== 1) continue;
    const local = group[0];
    const playlist = serverGroup[0];
    if (local === undefined || playlist === undefined) continue;
    claimed.add(playlist.id);
    entry(local.localKey, "merge", playlist.id, playlist.name);
  }
}

/**
 * The merge plan for `server` (every playlist of the user, live and deleted) against `input`, in the request's
 * order. Pure and deterministic given its arguments; {@link planMerge} is the only caller that touches the database.
 */
export function computeMergePlan(server: readonly ServerPlaylistSummary[], input: MergePlanRequest): MergePlanResponse {
  const byId = new Map(server.map((playlist) => [playlist.id, playlist]));
  const claimed = new Set<string>();
  const resolved = new Map<string, MergePlanEntry>();
  const entry: Entry = (localKey, action, playlistId, serverName) =>
    resolved.set(localKey, { localKey, action, playlistId, serverName });

  // 1. `syncId` of a live, unclaimed server playlist.
  for (const local of input.playlists) {
    if (local.syncId === undefined) continue;
    const server1 = byId.get(local.syncId);
    if (server1 !== undefined && !server1.deleted && !claimed.has(server1.id)) {
      claimed.add(server1.id);
      entry(local.localKey, "merge", server1.id, server1.name);
    }
  }

  // 2. `syncId` of a deleted server playlist: never claims (several locals may point at the same tombstone).
  for (const local of input.playlists) {
    if (resolved.has(local.localKey) || local.syncId === undefined) continue;
    const server2 = byId.get(local.syncId);
    if (server2?.deleted === true) entry(local.localKey, "deleted", server2.id, null);
  }

  // 3. `browseId`, exactly one on each side.
  matchOneToOne(
    input.playlists.filter((local) => !resolved.has(local.localKey)),
    server.filter((playlist) => !playlist.deleted && !claimed.has(playlist.id)),
    (local) => local.browseId ?? null,
    (playlist) => playlist.browseId,
    claimed,
    entry,
  );

  // 4. `norm(name)`, exactly one on each side of what pass 3 left.
  matchOneToOne(
    input.playlists.filter((local) => !resolved.has(local.localKey)),
    server.filter((playlist) => !playlist.deleted && !claimed.has(playlist.id)),
    (local) => normalizePlaylistName(local.name),
    (playlist) => normalizePlaylistName(playlist.name),
    claimed,
    entry,
  );

  // 5. Otherwise create: reuse `syncId` only when the server has never heard of it, live or deleted.
  for (const local of input.playlists) {
    if (resolved.has(local.localKey)) continue;
    const knownToServer = local.syncId !== undefined && byId.has(local.syncId);
    const playlistId = local.syncId !== undefined && !knownToServer ? local.syncId : newId();
    entry(local.localKey, "create", playlistId, null);
  }

  return {
    plan: input.playlists.map((local) => {
      const result = resolved.get(local.localKey);
      if (result === undefined) throw new Error(`merge plan: ${local.localKey} was never resolved`);
      return result;
    }),
  };
}

/** Reads every playlist of `userId` (live and deleted) and computes the plan; nothing is written (API §4.7). */
export async function planMerge(q: Queryable, userId: string, input: MergePlanRequest): Promise<MergePlanResponse> {
  const rows = await q
    .selectFrom("sync_playlists")
    .select(["id", "name", "browse_id", "deleted"])
    .where("user_id", "=", userId)
    .execute();
  const server: ServerPlaylistSummary[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    browseId: row.browse_id,
    deleted: row.deleted === 1,
  }));
  return computeMergePlan(server, input);
}
