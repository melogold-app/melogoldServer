/**
 * Parsing of the fields of `playlist.*` ops (API §4.8, DESIGN §3.9). The route checked only `opId`, `kind`, `at` and
 * `base`; every other field is checked here, per op, and a bad field never fails the batch:
 * - a missing required field, a wrong type or a length out of range → `deferred invalid_payload`;
 * - a videoId field (`videoId`, `videoIds[]`, `after`, `before`) that is a string but not a `VideoId` →
 *   `rejected invalid_video_id` (reported only when the op is otherwise well-formed);
 * - `name` is trimmed and cut to 200 UTF-16 units (an empty one becomes «Без названия» / «Untitled» when written);
 * - `thumbnailUrl` is lenient: anything but an `http(s)` URL of at most 2048 units becomes `null`.
 *
 * A `?` field may be absent or `null` (API §1.3); both mean "absent".
 */
import { BROWSE_ID_PATTERN, UUID_PATTERN, VIDEO_ID_PATTERN, isHttpUrl } from "../../../contract/common.ts";
import { STRING_LIMITS } from "../../../contract/limits.ts";
import type { SyncOpKind } from "../../../contract/sync.ts";
import { truncateUtf16 } from "../../../lib/strings.ts";
import { deferred, itemKey, notParsed, parsed, rejected } from "../ops/types.ts";
import type { OpParseResult, ParsedOp, ServerLocale, TouchedKeys, WireOp } from "../ops/types.ts";
import { dedupe } from "./anchors.ts";

/** Name of a playlist whose name is empty after trimming (DESIGN §3.9). */
export function defaultPlaylistName(locale: ServerLocale): string {
  return locale === "ru" ? "Без названия" : "Untitled";
}

/**
 * The stored form of a playlist name (DESIGN §3.9): trimmed, cut to 200 UTF-16 units without splitting a surrogate
 * pair, trimmed again (the cut may end in spaces). May be empty: the writer then uses {@link defaultPlaylistName}.
 */
export function cleanPlaylistName(value: string): string {
  return truncateUtf16(value.trim(), STRING_LIMITS.playlistName).trimEnd();
}

/** The name to store: {@link cleanPlaylistName} output, or the localized default when it is empty. */
export function playlistNameOrDefault(cleaned: string, locale: ServerLocale): string {
  return cleaned.length > 0 ? cleaned : defaultPlaylistName(locale);
}

/** Lenient `thumbnailUrl` of a playlist (API §4.8): an `http(s)` URL of at most 2048 units, otherwise `null`. */
export function lenientThumbnailUrl(value: unknown): string | null {
  return typeof value === "string" && isHttpUrl(value) ? value : null;
}

export type VideoIdsRange = Readonly<{ min: number; max: number }>;

/** Readers of one op's fields; a structural problem aborts the parse with `deferred invalid_payload`. */
export type OpFields = Readonly<{
  /** Required lowercase UUID. */
  playlistId(): string;
  /** Required videoId field. */
  videoId(): string;
  /** Optional anchor (`after`, `before`): `null` when absent. */
  anchor(field: "after" | "before"): string | null;
  /** `videoIds` with `range.min..range.max` elements (before de-duplication), de-duplicated. */
  videoIds(range: VideoIdsRange): string[];
  /** Optional `videoIds`: `[]` when absent. */
  optionalVideoIds(range: VideoIdsRange): string[];
  /** Required `name`, cleaned ({@link cleanPlaylistName}); may be empty. */
  name(): string;
  /** Optional `browseId` of a YouTube playlist: `null` when absent. */
  browseId(): string | null;
  /** Lenient `thumbnailUrl`: `null` when absent or invalid. */
  thumbnailUrl(): string | null;
}>;

class InvalidPayload extends Error {
  constructor(field: string) {
    super(`invalid op field ${field}`);
    this.name = "InvalidPayload";
  }
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/**
 * Parses a `playlist.*` op: `build` reads its fields through {@link OpFields}; `trackVideoIds` lists the videoIds
 * whose `sync_tracks` rows the runner creates afterwards (`[]` for ops that only touch existing items).
 */
export function parsePlaylistOp<F extends object>(
  raw: WireOp,
  kind: SyncOpKind,
  build: (fields: OpFields) => F,
  trackVideoIds: (fields: F) => readonly string[] = () => [],
): OpParseResult<ParsedOp & F> {
  // A property (not a bare `let`) so its type stays `boolean` at every read: TS keeps a `let` narrowed to its
  // initial literal across calls that can only reach the mutation through a nested closure (a known unsoundness),
  // which would make `no-unnecessary-condition` (wrongly) call the check below dead code.
  const state = { badVideoId: false };
  const checkVideoId = (value: string): string => {
    if (!VIDEO_ID_PATTERN.test(value)) state.badVideoId = true;
    return value;
  };
  const videoIdList = (field: string, value: unknown, range: VideoIdsRange): string[] => {
    if (!Array.isArray(value) || value.length < range.min || value.length > range.max) {
      throw new InvalidPayload(field);
    }
    const ids: string[] = [];
    for (const item of value as unknown[]) {
      if (typeof item !== "string") throw new InvalidPayload(field);
      ids.push(checkVideoId(item));
    }
    return dedupe(ids);
  };

  const fields: OpFields = Object.freeze({
    playlistId: () => {
      const value = raw.playlistId;
      if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new InvalidPayload("playlistId");
      return value;
    },
    videoId: () => {
      const value = raw.videoId;
      if (typeof value !== "string") throw new InvalidPayload("videoId");
      return checkVideoId(value);
    },
    anchor: (field: "after" | "before") => {
      const value = raw[field];
      if (!present(value)) return null;
      if (typeof value !== "string") throw new InvalidPayload(field);
      return checkVideoId(value);
    },
    videoIds: (range: VideoIdsRange) => videoIdList("videoIds", raw.videoIds, range),
    optionalVideoIds: (range: VideoIdsRange) =>
      present(raw.videoIds) ? videoIdList("videoIds", raw.videoIds, range) : [],
    name: () => {
      const value = raw.name;
      if (typeof value !== "string") throw new InvalidPayload("name");
      return cleanPlaylistName(value);
    },
    browseId: () => {
      const value = raw.browseId;
      if (!present(value)) return null;
      if (typeof value !== "string" || !BROWSE_ID_PATTERN.test(value)) throw new InvalidPayload("browseId");
      return value;
    },
    thumbnailUrl: () => lenientThumbnailUrl(raw.thumbnailUrl),
  });

  let value: F;
  try {
    value = build(fields);
  } catch (error) {
    if (error instanceof InvalidPayload) return notParsed(deferred("invalid_payload"));
    throw error;
  }
  if (state.badVideoId) return notParsed(rejected("invalid_video_id"));
  return parsed({
    opId: raw.opId,
    kind,
    at: raw.at,
    tracks: raw.tracks,
    trackVideoIds: trackVideoIds(value),
    ...value,
  });
}

/**
 * `touch` of every `playlist.*` handler: the playlist and the items the op names (`videoId`, `videoIds[]`), taken from
 * the raw op, so replays and rejected or deferred ops also return the current rows. Invalid values are skipped; never
 * throws.
 */
export function touchPlaylistOp(raw: WireOp, touched: TouchedKeys): void {
  const playlistId = raw.playlistId;
  if (typeof playlistId !== "string" || !UUID_PATTERN.test(playlistId)) return;
  touched.playlists.add(playlistId);
  const named: unknown[] = [raw.videoId, ...(Array.isArray(raw.videoIds) ? (raw.videoIds as unknown[]) : [])];
  for (const videoId of named) {
    if (typeof videoId === "string" && VIDEO_ID_PATTERN.test(videoId)) touched.items.add(itemKey(playlistId, videoId));
  }
}
