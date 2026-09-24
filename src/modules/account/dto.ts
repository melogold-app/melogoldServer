/**
 * Rows of the account module → contract DTOs (API §4.1, §4.5, §4.9). Times go out through `formatIso`; `BOOL` columns
 * through `fromDbBool`; `JSON` columns are decoded **leniently**: the export is a stream that has already started, so a
 * stored document that no longer matches its schema drops the bad part instead of aborting the download.
 */
import { z } from "zod";
import { ArtistRef, TrackDto } from "../../contract/common.ts";
import type { DeviceDto, TrackDto as TrackDtoValue, UserDto } from "../../contract/common.ts";
import type { PlaybackState } from "../../contract/playback.ts";
import type {
  BookmarkRow as BookmarkDto,
  LikeRow as LikeDto,
  PlayForgetRow as PlayForgetDto,
  PlayRow as PlayDto,
  PlayStatRow as PlayStatDto,
} from "../../contract/sync.ts";
import { fromDbBool } from "../../db/codecs.ts";
import { formatIso, formatIsoOrNull } from "../../lib/time.ts";
import { recentUntil } from "../security/policy.ts";
import type {
  AccountUserRow,
  BookmarkRow,
  DeviceRow,
  LikeRow,
  PlaybackRow,
  PlayForgetRow,
  PlayRow,
  PlayStatRow,
  TrackRow,
} from "./account.repository.ts";

/** API §4.1 `UserDto`. */
export function toUserDto(user: AccountUserRow): UserDto {
  return {
    id: user.id,
    login: user.login,
    createdAt: formatIso(user.created_at),
    passwordChangedAt: formatIso(user.password_changed_at),
    recoveryCodeStatus: {
      createdAt: formatIso(user.recovery_code_created_at),
      confirmed: user.recovery_code_confirmed_at !== null,
    },
  };
}

/** `customName ?? reportedName` (API §4.1 `DeviceDto.name`), also the `byDevice.name` of `account.updated`. */
export function deviceName(device: Pick<DeviceRow, "custom_name" | "reported_name">): string {
  return device.custom_name ?? device.reported_name;
}

/** API §4.1 `DeviceDto`; `recentUntil` by the matrix of DESIGN §4.8. */
export function toDeviceDto(
  device: DeviceRow,
  context: Readonly<{ currentDeviceId: string; now: number; newDeviceRestrictHours: number }>,
): DeviceDto {
  const until = recentUntil(
    { id: device.id, linkedVia: device.linked_via, createdAt: device.created_at },
    { now: context.now, newDeviceRestrictHours: context.newDeviceRestrictHours },
  );
  return {
    id: device.id,
    name: deviceName(device),
    reportedName: device.reported_name,
    customName: device.custom_name,
    platform: device.platform,
    osVersion: device.os_version,
    model: device.model,
    clientVersion: device.client_version,
    linkedVia: device.linked_via,
    linkedByDeviceId: device.linked_by_device_id,
    createdAt: formatIso(device.created_at),
    lastSeenAt: formatIso(device.last_seen_at),
    lastSyncAt: formatIsoOrNull(device.last_sync_at),
    recentUntil: formatIsoOrNull(until),
    isCurrent: device.id === context.currentDeviceId,
  };
}

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** `sync_tracks.artists` (JSON `ArtistRef[]`): items that do not match are dropped; anything else is `[]`. */
export function decodeArtists(text: string | null): z.output<typeof ArtistRef>[] {
  const value = parseJson(text);
  if (!Array.isArray(value)) return [];
  const artists: z.output<typeof ArtistRef>[] = [];
  for (const item of value) {
    const parsed = ArtistRef.safeParse(item);
    if (parsed.success) artists.push(parsed.data);
  }
  return artists;
}

/** API §4.1 `TrackDto` of a `sync_tracks` row. */
export function toTrackDto(row: TrackRow): TrackDtoValue {
  return {
    videoId: row.video_id,
    title: row.title,
    artistsText: row.artists_text,
    artists: decodeArtists(row.artists),
    albumId: row.album_id,
    albumTitle: row.album_title,
    durationMs: row.duration_ms,
    durationText: row.duration_text,
    thumbnailUrl: row.thumbnail_url,
    explicit: fromDbBool(row.explicit),
    videoType: row.video_type,
    metadataStub: fromDbBool(row.stub),
  };
}

export function toLikeDto(row: LikeRow): LikeDto {
  return { videoId: row.video_id, liked: fromDbBool(row.liked), likedAt: formatIsoOrNull(row.liked_at) };
}

export function toBookmarkDto(row: BookmarkRow): BookmarkDto {
  return {
    type: row.type,
    browseId: row.browse_id,
    bookmarked: fromDbBool(row.bookmarked),
    bookmarkedAt: formatIsoOrNull(row.bookmarked_at),
    title: row.title,
    subtitle: row.subtitle,
    thumbnailUrl: row.thumbnail_url,
    year: row.year,
  };
}

export function toPlayDto(row: PlayRow): PlayDto {
  return {
    eventId: row.event_id,
    videoId: row.video_id,
    playedAt: formatIso(row.played_at),
    playTimeMs: row.play_time_ms,
    deviceId: row.device_id,
  };
}

export function toPlayStatDto(row: PlayStatRow): PlayStatDto {
  return { videoId: row.video_id, totalPlayTimeMs: row.total_ms, lastPlayedAt: formatIsoOrNull(row.last_played_at) };
}

export function toPlayForgetDto(row: PlayForgetRow): PlayForgetDto {
  return {
    videoId: row.video_id,
    eventsBefore: formatIso(row.events_before),
    totalBefore: formatIsoOrNull(row.total_before),
  };
}

const StoredQueue = z.array(z.unknown());

/** `playback_state.queue` (JSON `TrackDto[]`): items that do not match are dropped. */
export function decodeQueue(text: string): TrackDtoValue[] {
  const parsed = StoredQueue.safeParse(parseJson(text));
  if (!parsed.success) return [];
  const queue: TrackDtoValue[] = [];
  for (const item of parsed.data) {
    const track = TrackDto.safeParse(item);
    if (track.success) queue.push(track.data);
  }
  return queue;
}

/**
 * API §4.9 `PlaybackState` of the stored row; `null` for no row, the `cleared` tombstone, or a queue that decodes to
 * nothing (API: 1..200 items).
 */
export function toPlaybackState(row: PlaybackRow | undefined): PlaybackState | null {
  if (row === undefined || fromDbBool(row.cleared)) return null;
  const queue = decodeQueue(row.queue);
  if (queue.length === 0) return null;
  const handoffFrom =
    row.handoff_device_id !== null && row.handoff_session_id !== null && row.handoff_at !== null
      ? { deviceId: row.handoff_device_id, sessionId: row.handoff_session_id, at: formatIso(row.handoff_at) }
      : null;
  return {
    rev: row.rev,
    deviceId: row.device_id,
    deviceName: row.device_name,
    sessionId: row.session_id,
    queueVersion: row.queue_version,
    index: Math.min(row.idx, queue.length - 1),
    positionMs: row.position_ms,
    durationMs: row.duration_ms,
    playing: fromDbBool(row.playing),
    at: formatIso(row.state_at),
    updatedAt: formatIso(row.updated_at),
    queue,
    handoffFrom,
  };
}
