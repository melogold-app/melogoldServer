/**
 * The Fastify application (DESIGN §6.3). Frozen after M0 (PLAN, general rules item 2). The **order of registration**
 * is part of the contract:
 *
 * 1. `createFastify`: logger with masking, request ids, `trustProxy` from `TRUST_PROXY`, default body limit, the zod
 *    validator and serializer; Fastify's own 503-on-close is off (draining answers in the API's error format).
 * 2. HTTP infrastructure (`src/http/index.ts`): the error handler **before any route** (API §2.1), request logging,
 *    draining, the route policy table, security headers, CORS, compression, body rules, sanitization,
 *    `X-Sync-Protocol`, the Bearer guard, rate limits, the disk guard.
 * 3. OpenAPI (`@fastify/swagger`), which collects every route registered after it.
 * 4. Route modules in the order of DESIGN §2: server, auth, devices, account, linking, live, sync, playback. Each
 *    module's `register*Routes(app, ctx)` runs in its own encapsulated plugin and inherits everything above.
 * 5. `preClose`: every SSE stream is closed, so `app.close()` never waits for open streams.
 *
 * `buildApp` does not listen and does not call `ready()`; `server.ts` listens, tests use `app.inject`.
 */
import fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type { Env } from "./config/env.ts";
import type { AppContext } from "./context.ts";
import { fastifyServerOptions, registerHttpInfrastructure } from "./http/index.ts";
import { registerOpenapi } from "./http/openapi.ts";
import type { LruSet } from "./lib/lru.ts";
import { registerAccountRoutes } from "./modules/account/account.routes.ts";
import { registerAuthRoutes } from "./modules/auth/auth.routes.ts";
import { registerDevicesRoutes } from "./modules/devices/devices.routes.ts";
import { registerLinkingRoutes } from "./modules/linking/linking.routes.ts";
import { registerLiveRoutes } from "./modules/live/live.routes.ts";
import { registerPlaybackRoutes } from "./modules/playback/playback.routes.ts";
import { registerServerRoutes } from "./modules/server/server.routes.ts";
import { registerSyncRoutes } from "./modules/sync/sync.routes.ts";

/** A route module: registers its routes on an encapsulated child of the application. */
export type RouteModule = (app: FastifyInstance, ctx: AppContext) => void | Promise<void>;

/** Route modules in registration order (DESIGN §2). */
export const ROUTE_MODULES: readonly Readonly<{ name: string; register: RouteModule }>[] = Object.freeze([
  { name: "server", register: registerServerRoutes },
  { name: "auth", register: registerAuthRoutes },
  { name: "devices", register: registerDevicesRoutes },
  { name: "account", register: registerAccountRoutes },
  { name: "linking", register: registerLinkingRoutes },
  { name: "live", register: registerLiveRoutes },
  { name: "sync", register: registerSyncRoutes },
  { name: "playback", register: registerPlaybackRoutes },
]);

/** Step 1: a bare instance with its logger (`server.ts` logs the startup with it before the routes exist). */
export function createFastify(env: Pick<Env, "LOG_LEVEL" | "TRUST_PROXY">): FastifyInstance {
  const app = fastify({ ...fastifyServerOptions(env), return503OnClosing: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  return app;
}

export type BuildAppOptions = Readonly<{
  /** The instance of {@link createFastify} to build on (default: a new one). */
  app?: FastifyInstance;
  /** Tests: share or inspect the guard's confirmed-`rid` cache. */
  confirmedRefreshIds?: LruSet<string>;
}>;

/** Steps 2–5 on `options.app` (or a new instance). */
export async function buildApp(ctx: AppContext, options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = options.app ?? createFastify(ctx.env);
  await registerHttpInfrastructure(app, {
    env: ctx.env,
    db: ctx.db,
    keys: ctx.keys,
    clock: ctx.clock,
    diskGuard: ctx.diskGuard,
    random: ctx.random,
    isDraining: ctx.lifecycle.isDraining,
    ...(options.confirmedRefreshIds ? { confirmedRefreshIds: options.confirmedRefreshIds } : {}),
  });
  await registerOpenapi(app);
  for (const module of ROUTE_MODULES) {
    await app.register(async (child) => {
      await module.register(child, ctx);
    });
  }
  app.addHook("preClose", (done) => {
    ctx.live.closeAll();
    done();
  });
  return app;
}
