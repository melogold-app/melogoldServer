/**
 * Parsing of op fields (DESIGN §3.9, API §4.8 "Мягкая нормализация"). The route checks only `opId`, `kind`, `at` and
 * `base`; everything else reaches the op handlers as it came (after the sanitization of API §1.4) and is read here.
 *
 * **Metadata never fails an op.** `tracks[]`, the metadata of bookmarks and the `thumbnailUrl` of playlists are
 * cleaned field by field with one rule: a string is cut to its limit without splitting a surrogate pair
 * (`truncateUtf16`), an empty string is `null`, a wrong type or an invalid URL/id is `null`, an empty `title` makes a
 * metadata stub, invalid items of `artists[]` and `tracks[]` are dropped. The limits are API §11 (UTF-16 units).
 *
 * **Structural fields** are strict: {@link requiredVideoId} and the other readers return the value, or the outcome
 * the op ends with — `rejected invalid_video_id` for a videoId field that is not a `VideoId` (the op can never apply,
 * the client drops it), `deferred invalid_payload` for a missing required field, a wrong type or a value out of range
 * (the client keeps it). `null` counts as absent (API §1.3). Handlers read videoId fields first, so an op with a bad
 * videoId is rejected even when other fields are wrong too.
 */
import type { ArtistRef } from "../../contract/common.ts";
import {
  BROWSE_ID_PATTERN,
  UUID_PATTERN,
  VIDEO_ID_PATTERN,
  VIDEO_TYPE_PATTERN,
  isHttpUrl,
} from "../../contract/common.ts";
import { INT32_MAX, STRING_LIMITS } from "../../contract/limits.ts";
import { truncateUtf16 } from "../../lib/strings.ts";
import { parseIso } from "../../lib/time.ts";
import { deferred, rejected } from "./ops/types.ts";
import type { OpOutcome, ServerLocale } from "./ops/types.ts";

// ---------------------------------------------------------------------------------------------------------------------
// Metadata: cleaned, never refused
// ---------------------------------------------------------------------------------------------------------------------

/** A string cut to `maxLength` UTF-16 units; not a string, or empty → `null`. */
export function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const text = truncateUtf16(value, maxLength);
  return text === "" ? null : text;
}

/**
 * A user-typed string (`track.override.set`, `lyrics.pin.set`): trimmed, cut to `maxLength` UTF-16 units; not a
 * string, or blank → `null`.
 */
export function cleanTrimmedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const text = truncateUtf16(value.trim(), maxLength).trimEnd();
  return text === "" ? null : text;
}

/** An `HttpUrl` (API §1.6: `^https?://`, up to 2048), else `null`: a cut URL would be a broken one. */
export function cleanUrl(value: unknown): string | null {
  return typeof value === "string" && isHttpUrl(value) ? value : null;
}

/** A `BrowseId`, else `null`. */
export function cleanBrowseId(value: unknown): string | null {
  return typeof value === "string" && BROWSE_ID_PATTERN.test(value) ? value : null;
}

/** `TrackDto.videoType`: `[a-z_]{1,32}`, else `null`. */
export function cleanVideoType(value: unknown): string | null {
  return typeof value === "string" && VIDEO_TYPE_PATTERN.test(value) ? value : null;
}

/** An integer in `min..max`, else `null`. */
export function cleanInt(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

export function cleanBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

const DURATION_MINUTES = /^(\d{1,6}):([0-5]\d)$/;
const DURATION_HOURS = /^(\d{1,4}):([0-5]\d):([0-5]\d)$/;

/** `"m:ss"` or `"h:mm:ss"` → milliseconds (DESIGN §3.3), `null` for another form or beyond `Int32`. */
export function durationTextToMs(text: string): number | null {
  const minutes = DURATION_MINUTES.exec(text);
  const hours = minutes ? null : DURATION_HOURS.exec(text);
  let seconds: number;
  if (minutes) seconds = Number(minutes[1]) * 60 + Number(minutes[2]);
  else if (hours) seconds = Number(hours[1]) * 3600 + Number(hours[2]) * 60 + Number(hours[3]);
  else return null;
  const ms = seconds * 1000;
  return ms <= INT32_MAX ? ms : null;
}

/** Milliseconds → `"m:ss"`, or `"h:mm:ss"` from one hour (DESIGN §3.3). */
export function durationMsToText(ms: number): string {
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/**
 * `artists[]` of a `TrackInput`: an item needs a non-blank `name` (cut to 200); an invalid `id` becomes `null`;
 * anything else is dropped. At most 50 items (API §4.1).
 */
export function cleanArtists(value: unknown): ArtistRef[] {
  if (!Array.isArray(value)) return [];
  const artists: ArtistRef[] = [];
  for (const item of value as unknown[]) {
    if (artists.length >= STRING_LIMITS.trackArtists) break;
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const name = typeof record.name === "string" ? truncateUtf16(record.name, STRING_LIMITS.artistName) : "";
    if (name.trim() === "") continue;
    artists.push({ id: cleanBrowseId(record.id), name });
  }
  return artists;
}

/** Track metadata after cleaning: everything of `TrackDto` but `videoId` and `metadataStub`. */
export type TrackMeta = Readonly<{
  title: string;
  artistsText: string | null;
  artists: readonly ArtistRef[];
  albumId: string | null;
  albumTitle: string | null;
  durationMs: number | null;
  durationText: string | null;
  thumbnailUrl: string | null;
  explicit: boolean;
  videoType: string | null;
}>;

/** One cleaned `TrackInput`: `meta` is `null` for a stub (no usable `title`). */
export type TrackInputValue = Readonly<{ videoId: string; meta: TrackMeta | null }>;

/**
 * One item of `tracks[]` (DESIGN §3.3, §3.9). `null` when the item is dropped: not an object, or no valid `videoId`.
 * A missing or blank `title` makes the whole item a stub (`meta: null`): a stub carries no metadata at all.
 * `durationMs` and `durationText` are derived from each other when only one came.
 */
export function parseTrackInput(value: unknown): TrackInputValue | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const videoId = record.videoId;
  if (typeof videoId !== "string" || !VIDEO_ID_PATTERN.test(videoId)) return null;
  const title = typeof record.title === "string" ? truncateUtf16(record.title, STRING_LIMITS.title) : "";
  if (title.trim() === "") return Object.freeze({ videoId, meta: null });

  let durationMs = cleanInt(record.durationMs, 0, INT32_MAX);
  let durationText = cleanText(record.durationText, STRING_LIMITS.durationText);
  if (durationMs === null && durationText !== null) durationMs = durationTextToMs(durationText);
  if (durationText === null && durationMs !== null) durationText = durationMsToText(durationMs);

  const meta: TrackMeta = Object.freeze({
    title,
    artistsText: cleanText(record.artistsText, STRING_LIMITS.title),
    artists: Object.freeze(cleanArtists(record.artists)),
    albumId: cleanBrowseId(record.albumId),
    albumTitle: cleanText(record.albumTitle, STRING_LIMITS.title),
    durationMs,
    durationText,
    thumbnailUrl: cleanUrl(record.thumbnailUrl),
    explicit: cleanBool(record.explicit) ?? false,
    videoType: cleanVideoType(record.videoType),
  });
  return Object.freeze({ videoId, meta });
}

/**
 * `SyncOp.tracks` → metadata by videoId, only for the videoIds the op mentions (`tracks[]` carries the metadata of
 * those, DESIGN §3.7). Not an array → nothing. For a repeated videoId the first real item wins over stubs and later
 * items.
 */
export function parseTrackInputs(value: unknown, mentioned: ReadonlySet<string>): Map<string, TrackMeta | null> {
  const result = new Map<string, TrackMeta | null>();
  if (!Array.isArray(value)) return result;
  for (const item of value as unknown[]) {
    const track = parseTrackInput(item);
    if (track === null || !mentioned.has(track.videoId)) continue;
    const known = result.get(track.videoId);
    if (known === undefined || (known === null && track.meta !== null)) result.set(track.videoId, track.meta);
  }
  return result;
}

/** Metadata of `bookmark.set` (API §4.8): cut to the limits, invalid → `null`. */
export type BookmarkMeta = Readonly<{
  title: string | null;
  subtitle: string | null;
  thumbnailUrl: string | null;
  year: string | null;
}>;

export function parseBookmarkMeta(raw: Readonly<Record<string, unknown>>): BookmarkMeta {
  return Object.freeze({
    title: cleanText(raw.title, STRING_LIMITS.title),
    subtitle: cleanText(raw.subtitle, STRING_LIMITS.title),
    thumbnailUrl: cleanUrl(raw.thumbnailUrl),
    year: cleanText(raw.year, STRING_LIMITS.year),
  });
}

/** The name the server gives a playlist without one (DESIGN §3.9, API §1.2 `Accept-Language`). */
export const UNTITLED_PLAYLIST: Readonly<Record<ServerLocale, string>> = Object.freeze({
  ru: "Без названия",
  en: "Untitled",
});

/** A playlist name (DESIGN §3.9): trimmed, cut to 200; empty → «Без названия» / «Untitled». */
export function playlistName(value: string, locale: ServerLocale): string {
  const name = truncateUtf16(value.trim(), STRING_LIMITS.playlistName).trimEnd();
  return name === "" ? UNTITLED_PLAYLIST[locale] : name;
}

// ---------------------------------------------------------------------------------------------------------------------
// Structural fields: the value, or the outcome of the op
// ---------------------------------------------------------------------------------------------------------------------

/** How a field read can end an op: `rejected invalid_video_id` or `deferred invalid_payload`. */
export type OpFailure = Extract<OpOutcome, { status: "rejected" | "deferred" }>;

export const INVALID_PAYLOAD: OpFailure = deferred("invalid_payload");
export const INVALID_VIDEO_ID: OpFailure = rejected("invalid_video_id");

/** Whether a reader returned a failure instead of a value (values are primitives or arrays). */
export function isOpFailure(value: unknown): value is OpFailure {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const absent = (value: unknown): value is null | undefined => value === undefined || value === null;

/** A required videoId field: absent or not a string → `invalid_payload`; not a `VideoId` → `invalid_video_id`. */
export function requiredVideoId(value: unknown): string | OpFailure {
  if (typeof value !== "string") return INVALID_PAYLOAD;
  return VIDEO_ID_PATTERN.test(value) ? value : INVALID_VIDEO_ID;
}

/** An optional videoId field (`after`, `before`): absent → `undefined`, otherwise as {@link requiredVideoId}. */
export function optionalVideoId(value: unknown): string | undefined | OpFailure {
  return absent(value) ? undefined : requiredVideoId(value);
}

/**
 * A required list of videoIds of `min..max` items (`videoIds`): not an array, a length out of range or a non-string
 * item → `invalid_payload`; a string item that is not a `VideoId` → `invalid_video_id`.
 */
export function requiredVideoIdList(value: unknown, min: number, max: number): string[] | OpFailure {
  if (!Array.isArray(value) || value.length < min || value.length > max) return INVALID_PAYLOAD;
  const items = value as unknown[];
  if (items.some((item) => typeof item !== "string")) return INVALID_PAYLOAD;
  const ids = items as string[];
  return ids.every((id) => VIDEO_ID_PATTERN.test(id)) ? ids : INVALID_VIDEO_ID;
}

export function requiredBool(value: unknown): boolean | OpFailure {
  return typeof value === "boolean" ? value : INVALID_PAYLOAD;
}

/** A required integer in `min..max`. */
export function requiredInt(value: unknown, min: number, max: number): number | OpFailure {
  return cleanInt(value, min, max) ?? INVALID_PAYLOAD;
}

/** A required `Iso` field (API §1.5) → epoch milliseconds. */
export function requiredIso(value: unknown): number | OpFailure {
  return (typeof value === "string" ? parseIso(value) : null) ?? INVALID_PAYLOAD;
}

/** An optional `Iso` field: absent → `undefined`; present but not an `Iso` → `invalid_payload`. */
export function optionalIso(value: unknown): number | undefined | OpFailure {
  return absent(value) ? undefined : requiredIso(value);
}

/** A required string that is one of `values`. */
export function requiredEnum<const T extends string>(value: unknown, values: readonly T[]): T | OpFailure {
  return typeof value === "string" && (values as readonly string[]).includes(value) ? (value as T) : INVALID_PAYLOAD;
}

/** A required `BrowseId`. */
export function requiredBrowseId(value: unknown): string | OpFailure {
  return cleanBrowseId(value) ?? INVALID_PAYLOAD;
}

/** A required `Uuid` (`playlistId`). */
export function requiredUuid(value: unknown): string | OpFailure {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value : INVALID_PAYLOAD;
}

/** A required string (any length; the handler normalizes it, e.g. {@link playlistName}). */
export function requiredString(value: unknown): string | OpFailure {
  return typeof value === "string" ? value : INVALID_PAYLOAD;
}
