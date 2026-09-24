/**
 * Routes of the `sync` module (API §4.7, §4.8, T2.1): summary, merge plan and `POST /sync`. All three require
 * `X-Sync-Protocol` (checked before validation, `src/http/sync-protocol.ts`).
 *
 * `POST /sync` validates `SyncRequestEnvelope` (only `opId`/`kind`/`at`/`base` of each op, DESIGN §3.9); OpenAPI shows
 * `SyncRequest` with the flat `SyncOp`. `POST /sync/merge-plan` calls T2.2's `planMerge`.
 *
 * `features.sync` (API §4.2) lists the op kinds with a real handler.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { AppContext } from "../../context.ts";
import {
  MergePlanRequest,
  MergePlanResponse,
  SyncRequest,
  SyncRequestEnvelope,
  SyncResponse,
  SyncSummary,
} from "../../contract/sync.ts";
import { requireAuth } from "../../http/auth-guard.ts";
import { operation } from "../../http/operation.ts";
import { syncFeature } from "../server/features.ts";
import { implementedOpKinds } from "./ops/index.ts";
import { localeFromAcceptLanguage } from "./ops/types.ts";
import { createSyncService } from "./sync.service.ts";

export function registerSyncRoutes(app: FastifyInstance, ctx: AppContext): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const service = createSyncService(ctx);
  ctx.features.declare("sync", () => syncFeature(implementedOpKinds(service.handlers)));

  routes.get(
    "/sync/summary",
    {
      schema: operation("GET", "/sync/summary", {
        operationId: "getSyncSummary",
        tag: "sync",
        summary: "Counts of the server library for the merge dialog",
        status: 200,
        response: SyncSummary,
      }),
    },
    (request) => service.summary(requireAuth(request)),
  );

  routes.post(
    "/sync/merge-plan",
    {
      schema: operation("POST", "/sync/merge-plan", {
        operationId: "planMerge",
        tag: "sync",
        summary: "Plan how local playlists merge with the server ones",
        description: "A pure function: nothing is written. `plan` follows the order of the request (API §4.7).",
        body: MergePlanRequest,
        status: 200,
        response: MergePlanResponse,
      }),
    },
    (request) => service.mergePlan(requireAuth(request), request.body),
  );

  routes.post(
    "/sync",
    {
      schema: operation("POST", "/sync", {
        operationId: "sync",
        tag: "sync",
        summary: "Send ops and receive the changes since the cursor",
        description:
          "Ops are idempotent: a repeated op answers `replayed: true`. Only `opId`, `kind`, `at` and `base` of each op " +
          "are validated here; a bad field of one op defers that op, never the batch. Work budget: Σ(videoIds + " +
          "entries + tracks) ≤ 20 000, else 413 (API §1.9, §4.8).",
        body: SyncRequestEnvelope,
        documentedBody: SyncRequest,
        status: 200,
        response: SyncResponse,
        errors: ["cursor_invalid", "cursor_expired"],
      }),
    },
    (request) =>
      service.sync(requireAuth(request), request.body, localeFromAcceptLanguage(request.headers["accept-language"])),
  );
}
