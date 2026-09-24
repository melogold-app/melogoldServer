/**
 * Lenient metadata cleaning for one `PlaybackPut.queue` item (DESIGN §3.9, API §4.9): `videoId` is already checked by
 * the contract (`TrackInput.videoId`); every other field is `unknown` and is cleaned here, field by field, exactly as
 * `/sync`'s `tracks[]` would be (the rule is shared, DESIGN §3.9: "Правило одно для tracks[], мета закладок и
 * thumbnailUrl плейлиста").
 *
 * - A wrong type or an invalid format never fails the request: the field becomes `null` (or its safe default).
 * - Strings are truncated to their limit without splitting a surrogate pair ({@link truncateUtf16}).
 * - An empty `title` turns the whole item into the canonical metadata stub (`title = videoId`, every other field at
 *   its empty value, `metadataStub: true`) — the same shape API.md shows for a track without metadata.
 * - Invalid `artists[]` items are dropped rather than nulling the whole array.
 */
import { BROWSE_ID_PATTERN, isHttpUrl, VIDEO_TYPE_PATTERN } from "../../contract/common.ts";
import type { ArtistRef, TrackDto, TrackInput } from "../../contract/common.ts";
import { INT32_MAX, STRING_LIMITS } from "../../contract/limits.ts";
import { truncateUtf16 } from "../../lib/strings.ts";

function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const truncated = truncateUtf16(value, maxLength);
  return truncated.length > 0 ? truncated : null;
}

function cleanBrowseId(value: unknown): string | null {
  return typeof value === "string" && BROWSE_ID_PATTERN.test(value) ? value : null;
}

function cleanThumbnailUrl(value: unknown): string | null {
  return typeof value === "string" && isHttpUrl(value) ? value : null;
}

function cleanDurationMs(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= INT32_MAX ? value : null;
}

function cleanVideoType(value: unknown): string | null {
  return typeof value === "string" && VIDEO_TYPE_PATTERN.test(value) ? value : null;
}

function cleanArtistItem(item: unknown): ArtistRef | null {
  if (typeof item !== "object" || item === null) return null;
  const record = item as Record<string, unknown>;
  const name = cleanText(record.name, STRING_LIMITS.artistName);
  if (name === null) return null;
  const id = cleanBrowseId(record.id);
  return { id, name };
}

/** `artists[]`: not an array, or nothing usable in it, becomes `[]` (DESIGN §3.9, API §4.1). */
function cleanArtists(value: unknown): ArtistRef[] {
  if (!Array.isArray(value)) return [];
  const result: ArtistRef[] = [];
  for (const item of value) {
    if (result.length >= STRING_LIMITS.trackArtists) break;
    const cleaned = cleanArtistItem(item);
    if (cleaned !== null) result.push(cleaned);
  }
  return result;
}

/** The canonical stub of API §4.1: `title = videoId`, no other metadata, `metadataStub: true`. */
function metadataStub(videoId: string): TrackDto {
  return {
    videoId,
    title: videoId,
    artistsText: null,
    artists: [],
    albumId: null,
    albumTitle: null,
    durationMs: null,
    durationText: null,
    thumbnailUrl: null,
    explicit: false,
    videoType: null,
    metadataStub: true,
  };
}

/**
 * Cleans one `TrackInput` into a `TrackDto` ready to store (DESIGN §3.9). `input.videoId` is trusted (the contract
 * already validated it); every other field is treated as untrusted `unknown`.
 */
export function cleanTrackInput(input: TrackInput): TrackDto {
  const title = cleanText(input.title, STRING_LIMITS.title);
  if (title === null) return metadataStub(input.videoId);
  return {
    videoId: input.videoId,
    title,
    artistsText: cleanText(input.artistsText, STRING_LIMITS.title),
    artists: cleanArtists(input.artists),
    albumId: cleanBrowseId(input.albumId),
    albumTitle: cleanText(input.albumTitle, STRING_LIMITS.title),
    durationMs: cleanDurationMs(input.durationMs),
    durationText: cleanText(input.durationText, STRING_LIMITS.durationText),
    thumbnailUrl: cleanThumbnailUrl(input.thumbnailUrl),
    explicit: typeof input.explicit === "boolean" ? input.explicit : false,
    videoType: cleanVideoType(input.videoType),
    metadataStub: false,
  };
}
