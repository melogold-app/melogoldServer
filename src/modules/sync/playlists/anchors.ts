/**
 * Anchors and the pure order functions of playlists (DESIGN §3.7 "Якоря", §3.13.3). Every client implements the same
 * functions to show pending ops over the server state; `spec/playlist-ops.vectors.json` holds the shared vectors.
 *
 * A list is the ordered `videoId`s of the present items of one playlist. Anchors of an insertion:
 * - `after` is in the list → right after it;
 * - otherwise `before` is in the list → right before it;
 * - otherwise at the end.
 *
 * To insert at the start, a client passes `before` = the first synced `videoId`.
 *
 * The server applies the same placement to rows (`../ops/playlist-*.ts`); order keys are the server's business
 * (`sort-keys.ts`): clients sort by `(sortKey, videoId)` ordinally.
 */

export type Anchors = Readonly<{ after?: string | null; before?: string | null }>;

/** `ids` without repetitions, first occurrence kept. */
export function dedupe(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/**
 * Where an insertion goes in `list`: the index the first inserted element gets.
 * `after ∈ list` → `idx(after) + 1`; else `before ∈ list` → `idx(before)`; else `list.length`.
 */
export function anchorIndex(list: readonly string[], anchors: Anchors): number {
  const after = anchors.after === undefined || anchors.after === null ? -1 : list.indexOf(anchors.after);
  if (after >= 0) return after + 1;
  const before = anchors.before === undefined || anchors.before === null ? -1 : list.indexOf(anchors.before);
  if (before >= 0) return before;
  return list.length;
}

/** `playlist.items.add`: `fresh = dedupe(ids) − list`, inserted as a block at the anchors. */
export function applyAdd(list: readonly string[], ids: readonly string[], anchors: Anchors = {}): string[] {
  const present = new Set(list);
  const fresh = dedupe(ids).filter((id) => !present.has(id));
  const index = anchorIndex(list, anchors);
  return [...list.slice(0, index), ...fresh, ...list.slice(index)];
}

/** `playlist.item.remove`: `list − v`. */
export function applyRemove(list: readonly string[], videoId: string): string[] {
  return list.filter((id) => id !== videoId);
}

/** `playlist.item.move`: `v ∉ list` → `list`; otherwise `v` is inserted into `rest = list − v` like an add. */
export function applyMove(list: readonly string[], videoId: string, anchors: Anchors = {}): string[] {
  if (!list.includes(videoId)) return [...list];
  const rest = applyRemove(list, videoId);
  const index = anchorIndex(rest, anchors);
  return [...rest.slice(0, index), videoId, ...rest.slice(index)];
}

/** `playlist.items.replace`: `dedupe(ids)`. */
export function applyReplace(_list: readonly string[], ids: readonly string[]): string[] {
  return dedupe(ids);
}

/** `playlist.import`: missing ids are appended in the given order: `list + (dedupe(ids) − list)`. */
export function applyImport(list: readonly string[], ids: readonly string[]): string[] {
  const present = new Set(list);
  return [...list, ...dedupe(ids).filter((id) => !present.has(id))];
}

/** `playlist.create`: an empty list becomes `dedupe(ids)`; a non-empty one stays. */
export function applyCreate(list: readonly string[], ids: readonly string[]): string[] {
  return list.length === 0 ? dedupe(ids) : [...list];
}
