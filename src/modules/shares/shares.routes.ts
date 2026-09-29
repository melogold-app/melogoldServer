/**
 * Routes of the `shares` module (API §4.11): snapshots of own playlists by link. `POST`/`GET /shares` and
 * `DELETE /shares/{shareId}` are the owner's (Bearer); `GET /shares/{shareId}` (JSON for the apps) and `GET /s/{shareId}`
 * (the browser page, outside OpenAPI) are public. Declares `ctx.features.declare("share", FEATURE_V1)`.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { AppContext } from "../../context.ts";
import { SHARE_ID_PATTERN } from "../../contract/limits.ts";
import { CreateShareRequest, ShareCreated, ShareDto, ShareIdParams, ShareList } from "../../contract/shares.ts";
import { requireAuth } from "../../http/auth-guard.ts";
import { AppError } from "../../http/errors.ts";
import { operation } from "../../http/operation.ts";
import { FEATURE_V1 } from "../server/features.ts";
import { LANDING_CSP, landingBaseUrl, landingLocale } from "../server/landing.ts";
import { renderSharePage } from "./shares.page.ts";
import { createShare, deleteMyShare, getShare, listMyShares, toShareDto } from "./shares.service.ts";

export function registerSharesRoutes(app: FastifyInstance, ctx: AppContext): void {
  ctx.features.declare("share", FEATURE_V1);
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const baseOf = (request: FastifyRequest) => landingBaseUrl(ctx.env.PUBLIC_URL, request.protocol, request.host);

  routes.post(
    "/shares",
    {
      schema: operation("POST", "/shares", {
        operationId: "createShare",
        tag: "shares",
        summary: "Share a snapshot of an own playlist by link",
        description:
          "The snapshot never changes; tracks are cleaned like a playback queue (DESIGN §3.9). At most 200 per user " +
          "(API §4.11).",
        body: CreateShareRequest,
        status: 201,
        response: ShareCreated,
        errors: ["share_limit_reached"],
      }),
    },
    async (request, reply) => {
      const created = await createShare(
        ctx,
        requireAuth(request).userId,
        request.body,
        baseOf(request),
        landingLocale(request.headers["accept-language"]),
      );
      return reply.code(201).send(created);
    },
  );

  routes.get(
    "/shares",
    {
      schema: operation("GET", "/shares", {
        operationId: "listShares",
        tag: "shares",
        summary: "The caller's snapshots, newest first",
        status: 200,
        response: ShareList,
      }),
    },
    (request) => listMyShares(ctx, requireAuth(request).userId, baseOf(request)),
  );

  routes.delete(
    "/shares/:shareId",
    {
      schema: operation("DELETE", "/shares/:shareId", {
        operationId: "deleteShare",
        tag: "shares",
        summary: "Delete one of the caller's snapshots",
        description: "The link stops working (API §4.11).",
        params: ShareIdParams,
        status: 204,
        errors: ["share_not_found"],
      }),
    },
    async (request, reply) => {
      await deleteMyShare(ctx, requireAuth(request).userId, request.params.shareId);
      return reply.code(204).send();
    },
  );

  routes.get(
    "/shares/:shareId",
    {
      schema: operation("GET", "/shares/:shareId", {
        operationId: "getShare",
        tag: "shares",
        summary: "A snapshot by link (no sign-in)",
        description: "The owner is not disclosed (API §4.11).",
        params: ShareIdParams,
        status: 200,
        response: ShareDto,
        errors: ["share_not_found"],
      }),
    },
    async (request) => {
      const share = await getShare(ctx, request.params.shareId);
      if (share === null) throw new AppError("share_not_found");
      return toShareDto(share, baseOf(request));
    },
  );

  routes.get("/s/:shareId", async (request, reply) => {
    const { shareId } = request.params as { shareId: string };
    const share = SHARE_ID_PATTERN.test(shareId) ? await getShare(ctx, shareId) : null;
    const html = renderSharePage({
      share,
      baseUrl: baseOf(request),
      instanceName: ctx.env.INSTANCE_NAME,
      locale: landingLocale(request.headers["accept-language"]),
    });
    return reply
      .code(share === null ? 404 : 200)
      .header("content-security-policy", LANDING_CSP)
      .header("vary", "Accept-Language")
      .type("text/html; charset=utf-8")
      .send(html);
  });
}
