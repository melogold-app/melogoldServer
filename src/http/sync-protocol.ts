/**
 * `X-Sync-Protocol` (API §1.2) on `/sync`, `/sync/summary`, `/sync/merge-plan` and `/playback/state`:
 * missing or not an integer → `400 invalid_request`; outside `[MIN_SYNC_PROTOCOL, SYNC_PROTOCOL]` →
 * `409 protocol_unsupported {minProtocol, maxProtocol}`. Checked in `preValidation`, before the body schema.
 */
import type { FastifyInstance } from "fastify";
import { MIN_SYNC_PROTOCOL, SYNC_PROTOCOL } from "../lib/protocol.ts";
import { AppError } from "./errors.ts";

export const SYNC_PROTOCOL_HEADER = "x-sync-protocol";
const INTEGER = /^\d{1,9}$/;

/** The refusal for a header value, or `null` when the version is supported. */
export function checkSyncProtocol(value: string | string[] | undefined): AppError | null {
  const path = `headers.${SYNC_PROTOCOL_HEADER}`;
  if (value === undefined) {
    return new AppError("invalid_request", { details: { issues: [{ path, code: "invalid_type" }] } });
  }
  if (typeof value !== "string" || !INTEGER.test(value)) {
    return new AppError("invalid_request", { details: { issues: [{ path, code: "invalid_format" }] } });
  }
  const version = Number(value);
  if (version < MIN_SYNC_PROTOCOL || version > SYNC_PROTOCOL) {
    return new AppError("protocol_unsupported", {
      details: { minProtocol: MIN_SYNC_PROTOCOL, maxProtocol: SYNC_PROTOCOL },
    });
  }
  return null;
}

export function registerSyncProtocolCheck(app: FastifyInstance): void {
  app.addHook("preValidation", (request, _reply, done) => {
    if (request.routeOptions.config.policy?.syncProtocol !== true) {
      done();
      return;
    }
    done(checkSyncProtocol(request.headers[SYNC_PROTOCOL_HEADER]) ?? undefined);
  });
}
