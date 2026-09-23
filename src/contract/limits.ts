/**
 * Code constants of the contract (API §11 `ServerLimits`, string limits, §1.4 number ranges). They are published in
 * `/server/info.limits` and never come from the environment, except the few `ServerLimits` fields that API §11 marks
 * as coming from env ({@link buildServerLimits}).
 */
import type { Env } from "../config/env.ts";

/** API §1.4: `Int32` fields are at most 2 147 483 647; every other integer is at most 2^53 − 1. */
export const INT32_MAX = 2_147_483_647;

/** API §11 `ServerLimits.sync` (all fixed). */
export const SYNC_LIMITS = Object.freeze({
  maxOpsPerRequest: 500,
  maxBodyBytes: 4_194_304,
  maxWorkUnitsPerRequest: 20_000,
  defaultPageSize: 500,
  maxPageSize: 2000,
  maxVideoIdsPerAdd: 500,
  maxVideoIdsPerList: 10_000,
  maxBaselineEntries: 500,
  maxIncludeKeys: 1000,
  maxPlaylists: 1000,
  maxPlaylistItems: 10_000,
  maxItemsTotal: 100_000,
  maxLikes: 100_000,
  maxBookmarksPerType: 20_000,
  maxTracks: 150_000,
  maxPlayStats: 100_000,
  maxPlayEvents: 60_000,
  playAddPerHour: 2000,
} as const);

/** API §11 `ServerLimits.playback`. */
export const PLAYBACK_LIMITS = Object.freeze({ queueMax: 200, maxBodyBytes: 131_072 } as const);

/** API §1.6 `Login` for a new account (the input limit is {@link LOGIN_INPUT_MAX_LENGTH}). */
export const LOGIN_LIMITS = Object.freeze({
  minLength: 3,
  maxLength: 32,
  pattern: "^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$",
} as const);

/** API §1.6: a login is accepted on input with 1..64 UTF-16 units, before normalization. */
export const LOGIN_INPUT_MAX_LENGTH = 64;

/** API §1.6 `Password` for a new password (plus at most {@link PASSWORD_MAX_UTF8_BYTES} UTF-8 bytes). */
export const PASSWORD_LIMITS = Object.freeze({ minLength: 8, maxLength: 128 } as const);

/** API §1.6: a password is at most 512 UTF-8 bytes, new or checked. */
export const PASSWORD_MAX_UTF8_BYTES = 512;

/**
 * API §11 "Лимиты строк", in UTF-16 units, plus the neighbouring limits of API §4.1 (`TrackDto.artists` ≤ 50) and
 * §1.6 (`HttpUrl` ≤ 2048, `BrowseId` ≤ 64).
 */
export const STRING_LIMITS = Object.freeze({
  /** `title`, `albumTitle`, `artistsText`, `subtitle`. */
  title: 500,
  artistName: 200,
  playlistName: 200,
  durationText: 16,
  year: 16,
  videoType: 32,
  url: 2048,
  deviceName: 64,
  /** `osVersion`, `model`, `clientVersion`. */
  deviceField: 64,
  browseId: 64,
  /** `TrackDto.artists` items. */
  trackArtists: 50,
} as const);

/** API §4.6: `PollLinkRequest.waitSeconds` is 0..25, default 25; `LinkCreated.longPollSeconds` is 25. */
export const LINK_LONG_POLL_SECONDS = 25;

/** API §4.7: `MergePlanRequest.playlists` has 0..5000 entries; `localKey` is 1..64. */
export const MERGE_PLAN_LIMITS = Object.freeze({ maxPlaylists: 5000, localKeyMaxLength: 64 } as const);

/** API §11 `ServerLimits`: the fixed constants above plus the env-driven fields. */
export type ServerLimitsValue = Readonly<{
  sync: typeof SYNC_LIMITS;
  history: Readonly<{ retentionDays: number; maxEvents: number; mergeUploadMax: number }>;
  playback: typeof PLAYBACK_LIMITS;
  account: Readonly<{
    maxDevices: number | null;
    newDeviceRestrictHours: number;
    login: typeof LOGIN_LIMITS;
    password: typeof PASSWORD_LIMITS;
  }>;
}>;

/** `/server/info.limits` for this configuration (API §11: `history` and two `account` fields come from env). */
export function buildServerLimits(
  env: Pick<
    Env,
    | "HISTORY_RETENTION_DAYS"
    | "HISTORY_MAX_EVENTS"
    | "HISTORY_MERGE_UPLOAD_MAX"
    | "MAX_DEVICES_PER_USER"
    | "NEW_DEVICE_RESTRICT_HOURS"
  >,
): ServerLimitsValue {
  return Object.freeze({
    sync: SYNC_LIMITS,
    history: Object.freeze({
      retentionDays: env.HISTORY_RETENTION_DAYS,
      maxEvents: env.HISTORY_MAX_EVENTS,
      mergeUploadMax: env.HISTORY_MERGE_UPLOAD_MAX,
    }),
    playback: PLAYBACK_LIMITS,
    account: Object.freeze({
      maxDevices: env.MAX_DEVICES_PER_USER,
      newDeviceRestrictHours: env.NEW_DEVICE_RESTRICT_HOURS,
      login: LOGIN_LIMITS,
      password: PASSWORD_LIMITS,
    }),
  });
}
