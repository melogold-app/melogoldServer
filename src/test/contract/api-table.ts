/**
 * The route table of API §3, read from `docs/API.md` for the contract tests: method, path (OpenAPI and Fastify
 * syntax), `operationId` (`null` for routes outside OpenAPI), auth, `X-Sync-Protocol`, the 2xx status.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export const API_MD = readFileSync(new URL("../../../docs/API.md", import.meta.url), "utf8");

export type ApiAuth = "public" | "bearer" | "refresh" | "pollSecret";

export type ApiRoute = Readonly<{
  method: string;
  /** `/auth/me/devices/{deviceId}` */
  path: string;
  /** `/auth/me/devices/:deviceId` */
  fastifyPath: string;
  operationId: string | null;
  auth: ApiAuth;
  syncProtocol: boolean;
  status: number;
  /** `sse`, `html` or `json`. */
  media: "json" | "html" | "sse";
}>;

export function apiSection(start: string, end: string): string {
  const from = API_MD.indexOf(start);
  const to = API_MD.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `section ${start} not found in docs/API.md`);
  return API_MD.slice(from, to);
}

function cells(line: string): string[] {
  return line
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

function authOf(cell: string): ApiAuth {
  if (cell.startsWith("Bearer")) return "bearer";
  if (cell === "refresh" || cell === "pollSecret") return cell;
  assert.equal(cell, "public", `unknown auth "${cell}"`);
  return "public";
}

/** Every row of API §3, including `/docs`. */
export function apiRoutes(): ApiRoute[] {
  const lines = apiSection("## 3. Эндпоинты", "## 4.")
    .split("\n")
    .filter((line) => line.startsWith("|") && !/^\|\s*-/.test(line))
    .slice(1);
  return lines.map((line) => {
    const [, method = "", pathCell = "", operationCell = "", authCell = "", statusCell = ""] = cells(line);
    const path = /`([^`]+)`/.exec(pathCell)?.[1] ?? "";
    const operationId = /^`(\w+)`$/.exec(operationCell)?.[1] ?? null;
    const status = Number(/^(\d{3})/.exec(statusCell)?.[1]);
    assert.ok(path.startsWith("/") && Number.isInteger(status), `cannot parse row: ${line}`);
    return Object.freeze({
      method,
      path,
      fastifyPath: path.replace(/\{(\w+)\}/g, ":$1"),
      operationId,
      auth: authOf(authCell),
      syncProtocol: authCell.includes("XSP"),
      status,
      media: statusCell.includes("SSE") ? "sse" : statusCell.includes("html") ? "html" : "json",
    });
  });
}
