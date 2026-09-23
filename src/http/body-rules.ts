/**
 * Request body rules (API §1.2, §1.9).
 *
 * - `POST`, `PUT` and `PATCH` must say `Content-Type: application/json` (UTF-8: a `charset` parameter, if present,
 *   must be `utf-8`). Anything else, including a missing header, is `415 unsupported_media_type`; it is checked in
 *   `preParsing`, before the body is read.
 * - The body is a JSON object, at least `{}`: an empty body is `400 invalid_json` (Fastify's JSON parser), a
 *   non-object fails the route schema (`400 invalid_request`).
 * - Only the JSON parser remains: Fastify's default `text/plain` parser is removed.
 * - Other methods have no body (API §1.2 applies the rule to `POST`, `PUT` and `PATCH` only). Fastify 5 still reads a
 *   `DELETE` body, so a client that sends `Content-Type: application/json` on every request would get `400 invalid_json`
 *   for an empty `DELETE /playback/state`: for these methods the body is ignored whatever its type.
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
  // Fastify's own JSON parser (empty → invalid_json, prototype poisoning → invalid_json), for body methods only.
  const parseJson = app.getDefaultJsonParser("error", "error");
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    // The default parser is callback-style and returns nothing.
    if (requiresJsonBody(request.method))
      void parseJson(request, typeof body === "string" ? body : body.toString(), done);
    else done(null, undefined);
  });
  // Reached only by the other methods (`preParsing` refuses any other type for POST/PUT/PATCH): the body is ignored.
  app.addContentTypeParser("*", (_request, _payload, done) => {
    done(null, undefined);
  });
  app.addHook("preParsing", async (request, _reply, payload) => {
    if (requiresJsonBody(request.method) && !isJsonContentType(request.headers["content-type"])) {
      throw new AppError("unsupported_media_type");
    }
    return payload;
  });
}
