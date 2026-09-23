/**
 * Routes of the `sync` module (API §4.7, §4.8, T2.1): summary, merge plan and `POST /sync`. All three require
 * `X-Sync-Protocol` (checked before validation, `src/http/sync-protocol.ts`).
 *
 * `POST /sync` validates `SyncRequestEnvelope` (only `opId`/`kind`/`at`/`base` of each op, DESIGN §3.9); OpenAPI shows
 * `SyncRequest` with the flat `SyncOp`.
 *
 * M0: development stubs with their complete schemas (PLAN step 0.8); every handler answers `501 not_implemented`.
 * T2.1 declares `ctx.features.declare("sync", () => syncFeature(implementedOpKinds(handlers)))`.
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
import { notImplemented, operation } from "../../http/operation.ts";

export function registerSyncRoutes(app: FastifyInstance, _ctx: AppContext): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();

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
    notImplemented,
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
    notImplemented,
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
    notImplemented,
  );
}
