/**
 * Routes of the `server` module (API §3 rows 1–5 and `/docs`): `GET /`, `/health`, `/health/live`, `/openapi.json`,
 * `/server/info`, and `/docs` when `OPENAPI_DOCS_UI=true`. All public; limits come from `route-policy.ts`.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { AppContext } from "../../context.ts";
import { HealthResponse, LivenessResponse, ServerInfo } from "../../contract/server.ts";
import { isSecureTransport } from "../../http/client-ip.ts";
import { operation } from "../../http/operation.ts";
import { renderDocsPage } from "./docs-page.ts";
import { LANDING_CSP, landingBaseUrl, landingLocale, renderLandingPage } from "./landing.ts";
import { buildServerInfo, checkReadiness } from "./server.service.ts";

/** API §1.2: `/server/info` may be cached for 60 s. */
export const SERVER_INFO_CACHE_CONTROL = "public, max-age=60";

export function registerServerRoutes(app: FastifyInstance, ctx: AppContext): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.get("/", (request, reply) => {
    const html = renderLandingPage({
      instanceName: ctx.env.INSTANCE_NAME,
      baseUrl: landingBaseUrl(ctx.env.PUBLIC_URL, request.protocol, request.host),
      serverId: ctx.serverId,
      version: ctx.env.APP_VERSION,
      sourceUrl: ctx.env.SOURCE_URL,
      privacyUrl: ctx.env.PRIVACY_URL,
      contact: ctx.env.CONTACT,
      locale: landingLocale(request.headers["accept-language"]),
    });
    return reply
      .header("content-security-policy", LANDING_CSP)
      .header("vary", "Accept-Language")
      .type("text/html; charset=utf-8")
      .send(html);
  });

  routes.get(
    "/health",
    {
      schema: operation("GET", "/health", {
        operationId: "getHealth",
        tag: "server",
        summary: "Readiness: the database answers SELECT 1 within 2 s",
        description: "503 `unavailable` while the server shuts down or without the database (API §4.2).",
        status: 200,
        response: HealthResponse,
        database: false,
        errors: ["unavailable"],
      }),
    },
    () => checkReadiness(ctx),
  );

  routes.get(
    "/health/live",
    {
      schema: operation("GET", "/health/live", {
        operationId: "getLiveness",
        tag: "server",
        summary: "Liveness: the process answers",
        status: 200,
        response: LivenessResponse,
        database: false,
      }),
    },
    () => Promise.resolve({ status: "ok" }),
  );

  routes.get("/openapi.json", (request, reply) =>
    reply.type("application/json; charset=utf-8").send(request.server.swagger()),
  );

  routes.get(
    "/server/info",
    {
      schema: operation("GET", "/server/info", {
        operationId: "getServerInfo",
        tag: "server",
        summary: "Discovery: server id, versions, features and limits",
        description:
          "Clients check `software`, `apiVersion`/`minApiVersion` and `features.sync.protocol`/`minProtocol` before " +
          "using a server (API §7.1). Cacheable for 60 s.",
        status: 200,
        response: ServerInfo,
      }),
    },
    async (request, reply) => {
      const info = await buildServerInfo(ctx, isSecureTransport(request));
      void reply.header("cache-control", SERVER_INFO_CACHE_CONTROL);
      return info;
    },
  );

  if (ctx.env.OPENAPI_DOCS_UI) {
    routes.get("/docs", (request, reply) =>
      reply
        .header("content-security-policy", LANDING_CSP)
        .type("text/html; charset=utf-8")
        .send(renderDocsPage(request.server.swagger() as Parameters<typeof renderDocsPage>[0])),
    );
  }
}
