/**
 * Routes of the `linking` module (API §4.6, T1.4): the new device's side (`/auth/link/*`, public or poll secret) and
 * the signed-in device's side (`/auth/me/links*`, Bearer).
 *
 * M0: development stubs with their complete schemas (PLAN step 0.8); every handler answers `501 not_implemented`.
 * T1.4 declares `deviceLinking` in `ctx.features` (`deviceLinkingFeature(ctx.env.LINK_TTL_SECONDS)`).
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { AppContext } from "../../context.ts";
import {
  ApproveLinkRequest,
  CancelLinkRequestRequest,
  ClaimLinkRequest,
  CreateLinkInviteRequest,
  CreateLinkRequestRequest,
  EmptyRequest,
  LinkClaimed,
  LinkCreated,
  LinkDecisionResponse,
  LinkDetails,
  LinkIdParams,
  LinkPollResponse,
  PollLinkRequest,
  ResolveLinkRequest,
} from "../../contract/linking.ts";
import { notImplemented, operation } from "../../http/operation.ts";

const RESOLVE_CODES = ["link_not_found", "link_already_claimed", "link_wrong_mode", "link_expired"] as const;

export function registerLinkingRoutes(app: FastifyInstance, _ctx: AppContext): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.post(
    "/auth/link/requests",
    {
      schema: operation("POST", "/auth/link/requests", {
        operationId: "createLinkRequest",
        tag: "linking",
        summary: "New device: start a link and show a QR code (mode request)",
        description: "At most 20 active requests per IP (API §1.10). Not retried automatically.",
        body: CreateLinkRequestRequest,
        status: 201,
        response: LinkCreated,
      }),
    },
    notImplemented,
  );

  routes.post(
    "/auth/link/claim",
    {
      schema: operation("POST", "/auth/link/claim", {
        operationId: "claimLink",
        tag: "linking",
        summary: "New device: claim an invite scanned from a signed-in device (mode invite)",
        description: "Show `verifyCode` large; the signed-in device approves with it (API §4.6). Not retried.",
        body: ClaimLinkRequest,
        status: 200,
        response: LinkClaimed,
        errors: RESOLVE_CODES,
      }),
    },
    notImplemented,
  );

  routes.post(
    "/auth/link/poll",
    {
      schema: operation("POST", "/auth/link/poll", {
        operationId: "pollLink",
        tag: "linking",
        summary: "New device: long-poll the link until the session is issued",
        description:
          "Answers at once when the status differs from `knownStatus`, otherwise waits up to `waitSeconds` (25). " +
          "After `completed` the same poll returns the same session for 60 s. HTTP client timeout: 35 s (API §4.6).",
        body: PollLinkRequest,
        status: 200,
        response: LinkPollResponse,
        errors: ["link_denied", "link_not_found", "device_limit_reached", "link_expired", "link_cancelled"],
      }),
    },
    notImplemented,
  );

  routes.post(
    "/auth/link/cancel",
    {
      schema: operation("POST", "/auth/link/cancel", {
        operationId: "cancelLinkRequest",
        tag: "linking",
        summary: "New device: cancel the link",
        body: CancelLinkRequestRequest,
        status: 204,
        errors: ["link_not_found"],
      }),
    },
    notImplemented,
  );

  routes.post(
    "/auth/me/links",
    {
      schema: operation("POST", "/auth/me/links", {
        operationId: "createLinkInvite",
        tag: "linking",
        summary: "Signed-in device: create an invite and show its QR code (mode invite)",
        description: "`pollSecret` of the answer is null. A fourth active invite cancels the oldest (API §4.6).",
        body: CreateLinkInviteRequest,
        status: 201,
        response: LinkCreated,
      }),
    },
    notImplemented,
  );

  routes.post(
    "/auth/me/links/resolve",
    {
      schema: operation("POST", "/auth/me/links/resolve", {
        operationId: "resolveLink",
        tag: "linking",
        summary: "Signed-in device: open a request by its QR token or user code (mode request)",
        description: "Exactly one of `linkToken` and `userCode`. The answer has status claimed and verifyChoices.",
        body: ResolveLinkRequest,
        status: 200,
        response: LinkDetails,
        errors: RESOLVE_CODES,
      }),
    },
    notImplemented,
  );

  routes.get(
    "/auth/me/links/:linkId",
    {
      schema: operation("GET", "/auth/me/links/:linkId", {
        operationId: "getLink",
        tag: "linking",
        summary: "Signed-in device: the approval card of a link",
        params: LinkIdParams,
        status: 200,
        response: LinkDetails,
        errors: ["link_not_found"],
      }),
    },
    notImplemented,
  );

  routes.post(
    "/auth/me/links/:linkId/approve",
    {
      schema: operation("POST", "/auth/me/links/:linkId/approve", {
        operationId: "approveLink",
        tag: "linking",
        summary: "Signed-in device: approve with the number shown on the new device",
        description:
          "A wrong number denies the link (409 link_verify_mismatch). Only from claimed and only by the approving " +
          "device; another device gets 404 (API §4.6).",
        params: LinkIdParams,
        body: ApproveLinkRequest,
        status: 200,
        response: LinkDecisionResponse,
        errors: [
          "link_not_found",
          "device_limit_reached",
          "link_not_claimed",
          "link_verify_mismatch",
          "link_expired",
          "link_cancelled",
        ],
      }),
    },
    notImplemented,
  );

  routes.post(
    "/auth/me/links/:linkId/deny",
    {
      schema: operation("POST", "/auth/me/links/:linkId/deny", {
        operationId: "denyLink",
        tag: "linking",
        summary: "Signed-in device: deny a link",
        params: LinkIdParams,
        body: EmptyRequest,
        status: 200,
        response: LinkDecisionResponse,
        errors: ["link_not_found", "link_expired"],
      }),
    },
    notImplemented,
  );

  routes.post(
    "/auth/me/links/:linkId/cancel",
    {
      schema: operation("POST", "/auth/me/links/:linkId/cancel", {
        operationId: "cancelLink",
        tag: "linking",
        summary: "Signed-in device: cancel its invite",
        params: LinkIdParams,
        body: EmptyRequest,
        status: 204,
        errors: ["link_not_found"],
      }),
    },
    notImplemented,
  );
}
