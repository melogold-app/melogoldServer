/**
 * The API contract in code (API §4, §6, §11 and `ErrorResponse` of §2.1): zod schemas registered with
 * `.meta({ id })` in zod's global registry, one per OpenAPI component. Frozen after M0 (PLAN, general rules item 2).
 *
 * {@link CONTRACT_COMPONENTS} lists every component once with its direction: request schemas are rendered with
 * `io: "input"` (what a client sends: transforms such as `Iso → epoch ms` are invisible), response schemas with
 * `io: "output"`. The OpenAPI generator emits each component once, under its own name.
 */
import { z } from "zod";
import {
  ChangePasswordRequest,
  ChangePasswordResponse,
  ConfirmRecoveryCodeRequest,
  DeleteAccountRequest,
  ExportAccount,
  ExportDocument,
  ExportHistory,
  ExportLibrary,
  ExportPlaylist,
  ExportPlaylistItem,
  ExportServer,
  RecoverRequest,
  RecoveryCodeResponse,
  RotateRecoveryCodeRequest,
} from "./account.ts";
import {
  LoginRequest,
  LogoutRequest,
  MeResponse,
  PowSolution,
  RefreshRequest,
  RefreshResponse,
  RegisterChallenge,
  RegisterRequest,
} from "./auth.ts";
import {
  ArtistRef,
  AuthSession,
  DeviceDto,
  DeviceInput,
  DevicePatch,
  ErrorResponse,
  RecoveryCodeStatus,
  TokenPair,
  TrackDto,
  TrackInput,
  UserDto,
  ValidationIssue,
} from "./common.ts";
import {
  DeviceListResponse,
  RenameDeviceRequest,
  RevokeDeviceRequest,
  RevokeOthersRequest,
  RevokeOthersResponse,
} from "./devices.ts";
import {
  ApproveLinkRequest,
  CancelLinkRequestRequest,
  ClaimLinkRequest,
  CreateLinkInviteRequest,
  CreateLinkRequestRequest,
  EmptyRequest,
  LinkAccount,
  LinkApprover,
  LinkClaimed,
  LinkCreated,
  LinkDecisionResponse,
  LinkDetails,
  LinkDeviceInfo,
  LinkPollResponse,
  PollLinkRequest,
  ResolveLinkRequest,
} from "./linking.ts";
import {
  AccountUpdatedPayload,
  DeviceRef,
  DevicesUpdatedPayload,
  LinkUpdatedPayload,
  LiveEvent,
  PlaybackSummary,
  PlaybackUpdatedPayload,
  SessionInvalidatedPayload,
  SyncChangedPayload,
  SystemConnectedPayload,
} from "./live.ts";
import {
  PlaybackHandoff,
  PlaybackHandoffInput,
  PlaybackPut,
  PlaybackPutResult,
  PlaybackState,
  PlaybackStateResponse,
} from "./playback.ts";
import {
  AccountLimits,
  DeviceLinkingFeature,
  FeatureVersion,
  HealthResponse,
  HistoryLimits,
  LivenessResponse,
  LoginLimits,
  PasswordLimits,
  PlaybackLimits,
  ServerFeatures,
  ServerInfo,
  ServerLimits,
  ServerLinks,
  SyncFeature,
  SyncLimits,
} from "./server.ts";
import {
  BaselineEntry,
  BookmarkKey,
  BookmarkRow,
  LikeRow,
  MergePlanEntry,
  MergePlanInput,
  MergePlanRequest,
  MergePlanResponse,
  OpResult,
  PlayForgetRow,
  PlaylistItemRow,
  PlaylistRow,
  PlayRow,
  PlayStatRow,
  SyncInclude,
  SyncOp,
  SyncRequest,
  SyncResponse,
  SyncSummary,
  SyncSummaryCounts,
} from "./sync.ts";

export * from "./account.ts";
export * from "./auth.ts";
export * from "./common.ts";
export * from "./devices.ts";
export * from "./limits.ts";
export * from "./linking.ts";
export * from "./live.ts";
export * from "./playback.ts";
export * from "./server.ts";
export * from "./sync.ts";

export type ComponentDirection = "request" | "response";

export type ContractComponent = Readonly<{ id: string; schema: z.ZodType; direction: ComponentDirection }>;

/** Bodies clients send and the objects inside them. */
const REQUEST_SCHEMAS: readonly z.ZodType[] = [
  TrackInput,
  DeviceInput,
  DevicePatch,
  PowSolution,
  RegisterRequest,
  LoginRequest,
  RefreshRequest,
  LogoutRequest,
  RenameDeviceRequest,
  RevokeDeviceRequest,
  RevokeOthersRequest,
  ChangePasswordRequest,
  RotateRecoveryCodeRequest,
  ConfirmRecoveryCodeRequest,
  DeleteAccountRequest,
  RecoverRequest,
  EmptyRequest,
  CreateLinkRequestRequest,
  CreateLinkInviteRequest,
  ResolveLinkRequest,
  ClaimLinkRequest,
  PollLinkRequest,
  ApproveLinkRequest,
  CancelLinkRequestRequest,
  MergePlanRequest,
  MergePlanInput,
  SyncRequest,
  SyncInclude,
  BookmarkKey,
  SyncOp,
  BaselineEntry,
  PlaybackPut,
  PlaybackHandoffInput,
];

/** Bodies the server sends (including errors and SSE events) and the objects inside them. */
const RESPONSE_SCHEMAS: readonly z.ZodType[] = [
  ValidationIssue,
  ErrorResponse,
  ArtistRef,
  TrackDto,
  DeviceDto,
  RecoveryCodeStatus,
  UserDto,
  TokenPair,
  AuthSession,
  HealthResponse,
  LivenessResponse,
  ServerInfo,
  ServerFeatures,
  SyncFeature,
  FeatureVersion,
  DeviceLinkingFeature,
  ServerLinks,
  ServerLimits,
  SyncLimits,
  HistoryLimits,
  PlaybackLimits,
  AccountLimits,
  LoginLimits,
  PasswordLimits,
  RegisterChallenge,
  RefreshResponse,
  MeResponse,
  DeviceListResponse,
  RevokeOthersResponse,
  ChangePasswordResponse,
  RecoveryCodeResponse,
  ExportDocument,
  ExportServer,
  ExportAccount,
  ExportLibrary,
  ExportHistory,
  ExportPlaylist,
  ExportPlaylistItem,
  LinkCreated,
  LinkDeviceInfo,
  LinkDetails,
  LinkAccount,
  LinkApprover,
  LinkClaimed,
  LinkPollResponse,
  LinkDecisionResponse,
  SyncSummary,
  SyncSummaryCounts,
  MergePlanResponse,
  MergePlanEntry,
  OpResult,
  SyncResponse,
  PlaylistRow,
  PlaylistItemRow,
  LikeRow,
  BookmarkRow,
  PlayRow,
  PlayStatRow,
  PlayForgetRow,
  PlaybackHandoff,
  PlaybackState,
  PlaybackStateResponse,
  PlaybackPutResult,
  LiveEvent,
  SystemConnectedPayload,
  SyncChangedPayload,
  PlaybackSummary,
  PlaybackUpdatedPayload,
  DevicesUpdatedPayload,
  SessionInvalidatedPayload,
  DeviceRef,
  AccountUpdatedPayload,
  LinkUpdatedPayload,
];

/**
 * Components whose names are not in API.md: objects API.md writes inline (API §1.1 forbids inline schemas) and the
 * unnamed `{}` body of deny/cancel.
 */
export const CONTRACT_NAMED_INLINE_OBJECTS: readonly string[] = Object.freeze([
  "ServerFeatures",
  "SyncFeature",
  "FeatureVersion",
  "DeviceLinkingFeature",
  "ServerLinks",
  "SyncLimits",
  "HistoryLimits",
  "PlaybackLimits",
  "AccountLimits",
  "LoginLimits",
  "PasswordLimits",
  "SyncSummaryCounts",
  "ExportServer",
  "ExportAccount",
  "ExportLibrary",
  "ExportHistory",
  "DeviceRef",
  "EmptyRequest",
]);

/** The component name of a registered schema (`.meta({ id })`), or `null`. */
export function componentId(schema: z.ZodType): string | null {
  const id = z.globalRegistry.get(schema)?.id;
  return typeof id === "string" ? id : null;
}

function component(schema: z.ZodType, direction: ComponentDirection): ContractComponent {
  const id = componentId(schema);
  if (id === null) throw new Error("contract schema without .meta({ id })");
  return Object.freeze({ id, schema, direction });
}

/** Every component of the contract, requests first, each exactly once. */
export const CONTRACT_COMPONENTS: readonly ContractComponent[] = Object.freeze([
  ...REQUEST_SCHEMAS.map((schema) => component(schema, "request")),
  ...RESPONSE_SCHEMAS.map((schema) => component(schema, "response")),
]);
