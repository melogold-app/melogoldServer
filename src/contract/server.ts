/**
 * API §4.2 (server: health, discovery) and §11 (`ServerLimits`). All responses.
 *
 * API.md writes `features`, `features.sync`, `features.deviceLinking`, the `{version}` features, `links` and the
 * parts of `ServerLimits` inline; they are named components here (API §1.1 forbids inline schemas): `ServerFeatures`,
 * `SyncFeature`, `DeviceLinkingFeature`, `FeatureVersion`, `ServerLinks`, `SyncLimits`, `HistoryLimits`,
 * `PlaybackLimits`, `AccountLimits`, `LoginLimits`, `PasswordLimits`.
 */
import { z } from "zod";
import { enumOut, Int32Out, IntOut, IsoOut, UuidOut } from "./common.ts";

export const HEALTH_STATUS_VALUES = ["ok"] as const;
export const DB_KIND_VALUES = ["sqlite", "postgres"] as const;
/** `ServerInfo.registration`: `first` is reported as `open` while there are no users (API §4.2). */
export const REGISTRATION_VALUES = ["open", "closed"] as const;
/** `ServerInfo.software` is always this (API §7.1 step 3). */
export const SOFTWARE_NAME = "melogold-server";

export const HealthResponse = z
  .object({
    status: enumOut(HEALTH_STATUS_VALUES),
    version: z.string(),
    db: enumOut(DB_KIND_VALUES),
  })
  .meta({ id: "HealthResponse", description: "Readiness: `SELECT 1` within 2 s (API §4.2)." });

export const LivenessResponse = z.object({ status: enumOut(HEALTH_STATUS_VALUES) }).meta({ id: "LivenessResponse" });

export const SyncFeature = z
  .object({
    protocol: IntOut,
    minProtocol: IntOut,
    kinds: z.array(z.string()).meta({ description: "Op kinds this server applies; clients create no other kinds." }),
    streams: z.array(z.string()).meta({ description: "Known values: library, history." }),
  })
  .meta({ id: "SyncFeature" });

export const FeatureVersion = z.object({ version: IntOut }).meta({ id: "FeatureVersion" });

export const DeviceLinkingFeature = z
  .object({
    version: IntOut,
    modes: z.array(z.string()).meta({ description: "Known values: request, invite." }),
    ttlSeconds: IntOut,
    longPollSeconds: IntOut,
  })
  .meta({ id: "DeviceLinkingFeature" });

export const ServerFeatures = z
  .object({
    sync: SyncFeature.optional(),
    playback: FeatureVersion.optional(),
    deviceLinking: DeviceLinkingFeature.optional(),
    recoveryCode: FeatureVersion.optional(),
    export: FeatureVersion.optional(),
    accountDeletion: FeatureVersion.optional(),
    registrationPow: FeatureVersion.optional().meta({ description: "Present while proof of work is required." }),
    lyrics: FeatureVersion.optional().meta({ description: "Lyrics of the user and shared ones (API §4.10)." }),
  })
  .meta({ id: "ServerFeatures", description: "An absent key means the feature is not supported (API §1.3)." });

export const SyncLimits = z
  .object({
    maxOpsPerRequest: IntOut,
    maxBodyBytes: IntOut,
    maxWorkUnitsPerRequest: IntOut,
    defaultPageSize: IntOut,
    maxPageSize: IntOut,
    maxVideoIdsPerAdd: IntOut,
    maxVideoIdsPerList: IntOut,
    maxBaselineEntries: IntOut,
    maxIncludeKeys: IntOut,
    maxPlaylists: IntOut,
    maxPlaylistItems: IntOut,
    maxItemsTotal: IntOut,
    maxLikes: IntOut,
    maxBookmarksPerType: IntOut,
    maxTracks: IntOut,
    maxPlayStats: IntOut,
    maxPlayEvents: IntOut,
    playAddPerHour: IntOut,
  })
  .meta({ id: "SyncLimits" });

export const HistoryLimits = z
  .object({ retentionDays: IntOut, maxEvents: IntOut, mergeUploadMax: IntOut })
  .meta({ id: "HistoryLimits" });

export const PlaybackLimits = z.object({ queueMax: IntOut, maxBodyBytes: IntOut }).meta({ id: "PlaybackLimits" });

export const LoginLimits = z
  .object({ minLength: IntOut, maxLength: IntOut, pattern: z.string() })
  .meta({ id: "LoginLimits", description: "Rules for a new login, after normalization." });

export const PasswordLimits = z
  .object({ minLength: IntOut, maxLength: IntOut })
  .meta({ id: "PasswordLimits", description: "Rules for a new password, in UTF-16 units." });

export const AccountLimits = z
  .object({
    maxDevices: Int32Out.nullable().meta({ description: "`null`: no limit." }),
    newDeviceRestrictHours: IntOut,
    login: LoginLimits,
    password: PasswordLimits,
  })
  .meta({ id: "AccountLimits" });

export const ServerLimits = z
  .object({
    sync: SyncLimits,
    history: HistoryLimits,
    playback: PlaybackLimits,
    account: AccountLimits,
  })
  .meta({ id: "ServerLimits", description: "Code constants (API §11); `history` and `account` partly from env." });

export const ServerLinks = z
  .object({
    source: z.string().meta({ description: "Source of this exact build (AGPL §13): …/tree/<GIT_SHA>." }),
    privacy: z.string().nullable(),
    contact: z.string().nullable(),
  })
  .meta({ id: "ServerLinks" });

export const ServerInfo = z
  .object({
    software: z.string().meta({ description: 'Always "melogold-server".' }),
    version: z.string().meta({ description: "semver" }),
    revision: z.string().meta({ description: "git sha (7)" }),
    apiVersion: IntOut,
    minApiVersion: IntOut,
    serverId: UuidOut,
    instanceName: z.string(),
    publicUrl: z.string().nullable(),
    secureTransport: z.boolean().meta({ description: "The request came over https (TRUST_PROXY considered)." }),
    registration: enumOut(REGISTRATION_VALUES, '"first" is reported as open while there are no users.'),
    features: ServerFeatures,
    limits: ServerLimits,
    links: ServerLinks,
    serverTime: IsoOut,
  })
  .meta({ id: "ServerInfo", description: "Discovery (API §4.2, §7.1)." });

export type HealthResponse = z.output<typeof HealthResponse>;
export type LivenessResponse = z.output<typeof LivenessResponse>;
export type ServerFeatures = z.output<typeof ServerFeatures>;
export type ServerLimits = z.output<typeof ServerLimits>;
export type ServerInfo = z.output<typeof ServerInfo>;
