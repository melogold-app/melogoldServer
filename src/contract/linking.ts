/**
 * API §4.6: linking a device by QR or code through the server (states DESIGN §4.10.3).
 *
 * `POST /auth/me/links/{linkId}/deny` and `/cancel` take `{}` (API §4.6 "Отмена"), a body API.md does not name; it
 * is the component `EmptyRequest` here (API §1.1: every body is a named component).
 */
import { z } from "zod";
import {
  AuthSession,
  DeviceInput,
  enumOut,
  int,
  IntOut,
  IsoOut,
  LINK_TOKEN_PATTERN,
  LinkToken,
  optional,
  POLL_SECRET_PATTERN,
  PollSecret,
  USER_CODE_OUTPUT_PATTERN,
  UserCodeInput,
  Uuid,
  UuidOut,
  VERIFY_CODE_PATTERN,
  VerifyCode,
} from "./common.ts";
import { LINK_LONG_POLL_SECONDS } from "./limits.ts";

export const LINK_MODE_VALUES = ["request", "invite"] as const;
export type LinkMode = (typeof LINK_MODE_VALUES)[number];

/** Every status of `LinkDetails.status`; `expired` is computed and never stored (DESIGN §4.10.3). */
export const LINK_STATUS_VALUES = [
  "pending",
  "claimed",
  "approved",
  "denied",
  "cancelled",
  "completed",
  "expired",
] as const;
export type LinkStatus = (typeof LINK_STATUS_VALUES)[number];

/** `LinkPollResponse.status` (other outcomes of poll are errors: `link_denied`, `link_expired`, `link_cancelled`). */
export const LINK_POLL_STATUS_VALUES = ["pending", "claimed", "completed"] as const;
/** `PollLinkRequest.knownStatus`. */
export const LINK_KNOWN_STATUS_VALUES = ["pending", "claimed"] as const;
/** `LinkDecisionResponse.status`. */
export const LINK_DECISION_VALUES = ["approved", "denied"] as const;

/** Path parameters of `/auth/me/links/{linkId}…` (API §3: a malformed id → `400 invalid_request`). */
export const LinkIdParams = z.object({ linkId: Uuid });

/** `{}`: the body of deny and cancel by the signed-in device. */
export const EmptyRequest = z.object({}).meta({ id: "EmptyRequest", description: "An empty JSON object." });

export const CreateLinkRequestRequest = z.object({ device: DeviceInput }).meta({ id: "CreateLinkRequestRequest" });

export const CreateLinkInviteRequest = z
  .object({})
  .meta({ id: "CreateLinkInviteRequest", description: "An empty JSON object." });

export const LinkCreated = z
  .object({
    linkId: UuidOut,
    mode: enumOut(LINK_MODE_VALUES),
    serverId: UuidOut,
    linkToken: z
      .string()
      .meta({ pattern: LINK_TOKEN_PATTERN.source, description: "Goes into the QR code (API §7.2)." }),
    userCode: z
      .string()
      .meta({ pattern: USER_CODE_OUTPUT_PATTERN.source, description: 'For manual entry, shown as "K7QX-M2PD".' }),
    pollSecret: z.string().nullable().meta({
      pattern: POLL_SECRET_PATTERN.source,
      description: "Only mode=request; never shown or put into a QR code.",
    }),
    expiresAt: IsoOut,
    longPollSeconds: IntOut,
  })
  .meta({ id: "LinkCreated" });

/** Exactly one of `linkToken` and `userCode` (API §4.6). */
function exactlyOneCode(
  value: { linkToken?: string | undefined; userCode?: string | undefined },
  ctx: z.RefinementCtx,
) {
  const given = (value.linkToken === undefined ? 0 : 1) + (value.userCode === undefined ? 0 : 1);
  if (given !== 1) {
    ctx.addIssue({
      code: "custom",
      path: [value.linkToken === undefined ? "linkToken" : "userCode"],
      message: "Exactly one of linkToken and userCode is required",
    });
  }
}

export const ResolveLinkRequest = z
  .object({ linkToken: optional(LinkToken), userCode: optional(UserCodeInput) })
  .superRefine(exactlyOneCode)
  .meta({ id: "ResolveLinkRequest", description: "Exactly one of linkToken and userCode." });

export const ClaimLinkRequest = z
  .object({ linkToken: optional(LinkToken), userCode: optional(UserCodeInput), device: DeviceInput })
  .superRefine(exactlyOneCode)
  .meta({ id: "ClaimLinkRequest", description: "Exactly one of linkToken and userCode." });

export const LinkDeviceInfo = z
  .object({
    name: z.string(),
    platform: z.string(),
    osVersion: z.string().nullable(),
    model: z.string().nullable(),
    clientVersion: z.string().nullable(),
    alreadyLinked: z.boolean(),
  })
  .meta({ id: "LinkDeviceInfo", description: 'What the new device "reports about itself".' });

export const LinkDetails = z
  .object({
    linkId: UuidOut,
    mode: enumOut(LINK_MODE_VALUES),
    status: enumOut(LINK_STATUS_VALUES),
    createdAt: IsoOut,
    expiresAt: IsoOut,
    device: LinkDeviceInfo.nullable().meta({ description: "`null` until an invite is claimed." }),
    sameNetwork: z.boolean().nullable().meta({
      description: "IPv4 whole / IPv6 /56; `null`: unknown or LINK_NETWORK_HINT=false.",
    }),
    verifyChoices: z
      .array(z.string().meta({ pattern: VERIFY_CODE_PATTERN.source }))
      .meta({ description: "Three VerifyCode choices while claimed, otherwise []." }),
  })
  .meta({ id: "LinkDetails", description: "resolve and GET /auth/me/links/{linkId}." });

export const LinkAccount = z.object({ login: z.string() }).meta({ id: "LinkAccount" });

export const LinkApprover = z.object({ name: z.string(), platform: z.string() }).meta({ id: "LinkApprover" });

export const LinkClaimed = z
  .object({
    linkId: UuidOut,
    status: enumOut(["claimed"]),
    pollSecret: z.string().meta({ pattern: POLL_SECRET_PATTERN.source }),
    account: LinkAccount,
    approverDevice: LinkApprover,
    verifyCode: z
      .string()
      .meta({ pattern: VERIFY_CODE_PATTERN.source, description: "Show it large on the new device." }),
    expiresAt: IsoOut,
    longPollSeconds: IntOut,
  })
  .meta({ id: "LinkClaimed" });

export const PollLinkRequest = z
  .object({
    pollSecret: PollSecret,
    waitSeconds: optional(int(0, LINK_LONG_POLL_SECONDS)).meta({ default: LINK_LONG_POLL_SECONDS }),
    knownStatus: optional(z.enum(LINK_KNOWN_STATUS_VALUES)).meta({
      description: "Answer at once when the status differs, otherwise wait up to waitSeconds.",
    }),
  })
  .meta({ id: "PollLinkRequest" });

export const LinkPollResponse = z
  .object({
    linkId: UuidOut,
    status: enumOut(LINK_POLL_STATUS_VALUES),
    expiresAt: IsoOut,
    account: LinkAccount.nullable().meta({ description: "Not null from claimed on." }),
    approverDevice: LinkApprover.nullable().meta({ description: "Not null from claimed on." }),
    verifyCode: z
      .string()
      .nullable()
      .meta({ pattern: VERIFY_CODE_PATTERN.source, description: "Not null from claimed on: SHOW it large." }),
    session: AuthSession.nullable().meta({ description: "Only when completed." }),
  })
  .meta({ id: "LinkPollResponse" });

export const ApproveLinkRequest = z.object({ verifyCode: VerifyCode }).meta({ id: "ApproveLinkRequest" });

export const CancelLinkRequestRequest = z.object({ pollSecret: PollSecret }).meta({ id: "CancelLinkRequestRequest" });

export const LinkDecisionResponse = z
  .object({ linkId: UuidOut, status: enumOut(LINK_DECISION_VALUES) })
  .meta({ id: "LinkDecisionResponse" });

export type LinkIdParams = z.output<typeof LinkIdParams>;
export type CreateLinkRequestRequest = z.output<typeof CreateLinkRequestRequest>;
export type LinkCreated = z.output<typeof LinkCreated>;
export type ResolveLinkRequest = z.output<typeof ResolveLinkRequest>;
export type ClaimLinkRequest = z.output<typeof ClaimLinkRequest>;
export type LinkDeviceInfo = z.output<typeof LinkDeviceInfo>;
export type LinkDetails = z.output<typeof LinkDetails>;
export type LinkAccount = z.output<typeof LinkAccount>;
export type LinkApprover = z.output<typeof LinkApprover>;
export type LinkClaimed = z.output<typeof LinkClaimed>;
export type PollLinkRequest = z.output<typeof PollLinkRequest>;
export type LinkPollResponse = z.output<typeof LinkPollResponse>;
export type ApproveLinkRequest = z.output<typeof ApproveLinkRequest>;
export type CancelLinkRequestRequest = z.output<typeof CancelLinkRequestRequest>;
export type LinkDecisionResponse = z.output<typeof LinkDecisionResponse>;
