/**
 * Request body rules (API §1.2, §1.9).
 *
 * - `POST`, `PUT` and `PATCH` must say `Content-Type: application/json` (UTF-8: a `charset` parameter, if present,
 *   must be `utf-8`). Anything else, including a missing header, is `415 unsupported_media_type`; it is checked in
 *   `preParsing`, before the body is read.
 * - The body is a JSON object, at least `{}`: an empty body is `400 invalid_json` (Fastify's JSON parser), a
 *   non-object fails the route schema (`400 invalid_request`).
 * - Only the JSON parser remains: Fastify's default `text/plain` parser is removed.
 * - Size limits per route come from `route-policy.ts` (`413 payload_too_large`).
 */
import type { FastifyInstance } from "fastify";
import { AppError } from "./errors.ts";

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

/** Whether a `Content-Type` header value is JSON in UTF-8. */
export function isJsonContentType(header: string | undefined): boolean {
  if (header === undefined) return false;
  const [mediaType = "", ...parameters] = header.split(";");
  if (mediaType.trim().toLowerCase() !== "application/json") return false;
  for (const parameter of parameters) {
    const [name = "", ...rest] = parameter.split("=");
    if (name.trim().toLowerCase() !== "charset") continue;
    const charset = rest
      .join("=")
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .toLowerCase();
    if (charset !== "utf-8" && charset !== "utf8") return false;
  }
  return true;
}

/** Whether a request with this method must carry a JSON body. */
export function requiresJsonBody(method: string): boolean {
  return BODY_METHODS.has(method.toUpperCase());
}

export function registerBodyRules(app: FastifyInstance): void {
  app.removeContentTypeParser("text/plain");
  app.addHook("preParsing", async (request, _reply, payload) => {
    if (requiresJsonBody(request.method) && !isJsonContentType(request.headers["content-type"])) {
      throw new AppError("unsupported_media_type");
    }
    return payload;
  });
}
