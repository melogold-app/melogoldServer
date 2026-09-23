/**
 * API §4.5: password, recovery code, recover, deletion, export.
 *
 * `ExportDocument.server`, `.account`, `.library` and `.history` are written inline in API.md; they are the named
 * components `ExportServer`, `ExportAccount`, `ExportLibrary`, `ExportHistory` here (API §1.1).
 */
import { z } from "zod";
import {
  BrowseIdOut,
  CheckedPassword,
  DeviceDto,
  DeviceInput,
  HttpUrlOut,
  IntOut,
  Iso,
  IsoOut,
  Login,
  NewPassword,
  optional,
  RECOVERY_CODE_OUTPUT_PATTERN,
  RecoveryCodeInput,
  TokenPair,
  TrackDto,
  UserDto,
  UuidOut,
  VideoIdOut,
} from "./common.ts";
import { STRING_LIMITS } from "./limits.ts";
import { PlaybackState } from "./playback.ts";
import { BookmarkRow, LikeRow, PlayForgetRow, PlayRow, PlayStatRow } from "./sync.ts";

export const ChangePasswordRequest = z
  .object({
    currentPassword: optional(CheckedPassword).meta({
      description: "Omitted: allowed from any signed-in device; the others get password_changed_without_old.",
    }),
    newPassword: NewPassword,
    signOutOtherDevices: optional(z.boolean()).meta({ default: false }),
  })
  .meta({ id: "ChangePasswordRequest" });

export const ChangePasswordResponse = z
  .object({ user: UserDto, tokens: TokenPair, signedOutDevices: IntOut })
  .meta({ id: "ChangePasswordResponse" });

export const RotateRecoveryCodeRequest = z
  .object({ password: CheckedPassword })
  .meta({ id: "RotateRecoveryCodeRequest" });

export const RecoveryCodeResponse = z
  .object({
    recoveryCode: z.string().meta({
      pattern: RECOVERY_CODE_OUTPUT_PATTERN.source,
      description: "XXXX-XXXX-XXXX-XXXX-XXXX, shown once.",
    }),
    createdAt: IsoOut,
  })
  .meta({ id: "RecoveryCodeResponse" });

export const ConfirmRecoveryCodeRequest = z
  .object({ recoveryCodeCreatedAt: Iso })
  .meta({ id: "ConfirmRecoveryCodeRequest", description: '"I saved the code" for the code created at this time.' });

export const DeleteAccountRequest = z.object({ password: CheckedPassword }).meta({ id: "DeleteAccountRequest" });

export const RecoverRequest = z
  .object({
    login: Login,
    recoveryCode: RecoveryCodeInput,
    newPassword: NewPassword,
    device: DeviceInput,
  })
  .meta({ id: "RecoverRequest" });

export const ExportPlaylistItem = z
  .object({ videoId: VideoIdOut, addedAt: IsoOut })
  .meta({ id: "ExportPlaylistItem", description: "Ordered by sortKey, then videoId (ordinal)." });

export const ExportPlaylist = z
  .object({
    id: UuidOut,
    name: z.string().meta({ minLength: 1, maxLength: STRING_LIMITS.playlistName }),
    browseId: BrowseIdOut.nullable(),
    thumbnailUrl: HttpUrlOut.nullable(),
    createdAt: IsoOut,
    items: z.array(ExportPlaylistItem),
  })
  .meta({ id: "ExportPlaylist" });

export const ExportServer = z
  .object({ serverId: UuidOut, instanceName: z.string(), version: z.string() })
  .meta({ id: "ExportServer" });

export const ExportAccount = z
  .object({ id: UuidOut, login: z.string(), createdAt: IsoOut, passwordChangedAt: IsoOut })
  .meta({ id: "ExportAccount" });

export const ExportLibrary = z
  .object({
    tracks: z.array(TrackDto),
    likes: z.array(LikeRow).meta({ description: "Liked only." }),
    bookmarks: z.array(BookmarkRow).meta({ description: "Bookmarked only." }),
    playlists: z.array(ExportPlaylist).meta({ description: "Live playlists only." }),
  })
  .meta({ id: "ExportLibrary" });

export const ExportHistory = z
  .object({
    plays: z.array(PlayRow).meta({ description: "Events in the history (in_history) only." }),
    playStats: z.array(PlayStatRow),
    playForgets: z.array(PlayForgetRow),
  })
  .meta({ id: "ExportHistory" });

export const EXPORT_FORMAT = "melogold-export";
export const EXPORT_FORMAT_VERSION = 1;

export const ExportDocument = z
  .object({
    format: z.string().meta({ description: 'Always "melogold-export".' }),
    formatVersion: IntOut.meta({ description: "1" }),
    exportedAt: IsoOut,
    server: ExportServer,
    account: ExportAccount,
    devices: z.array(DeviceDto),
    library: ExportLibrary,
    history: ExportHistory,
    playback: PlaybackState.nullable(),
  })
  .meta({
    id: "ExportDocument",
    description: "Streamed; not an atomic snapshot; contains no secrets (no hashes, tokens or hwid).",
  });

export type ChangePasswordRequest = z.output<typeof ChangePasswordRequest>;
export type ChangePasswordResponse = z.output<typeof ChangePasswordResponse>;
export type RotateRecoveryCodeRequest = z.output<typeof RotateRecoveryCodeRequest>;
export type RecoveryCodeResponse = z.output<typeof RecoveryCodeResponse>;
export type ConfirmRecoveryCodeRequest = z.output<typeof ConfirmRecoveryCodeRequest>;
export type DeleteAccountRequest = z.output<typeof DeleteAccountRequest>;
export type RecoverRequest = z.output<typeof RecoverRequest>;
export type ExportPlaylistItem = z.output<typeof ExportPlaylistItem>;
export type ExportPlaylist = z.output<typeof ExportPlaylist>;
export type ExportDocument = z.output<typeof ExportDocument>;
