/**
 * `HEALTHCHECK` of the image (DESIGN §7.1): `node /app/src/healthcheck.ts` asks `GET /health` of the local server and
 * exits 0 on `200`, 1 otherwise (including a timeout of 4 s, below Docker's 5 s). It reads only `HOST` and `PORT`.
 */
import { request } from "node:http";
import { loadEnv } from "./config/env.ts";

export const HEALTHCHECK_TIMEOUT_MS = 4000;

/** The address to probe: the listening address, or loopback when the server listens on every interface. */
export function probeHost(host: string): string {
  if (host === "0.0.0.0" || host === "") return "127.0.0.1";
  if (host === "::" || host === "[::]") return "::1";
  return host.replace(/^\[(.*)\]$/, "$1");
}

/** Whether `GET http://host:port/health` answers 200 in time. */
export function checkHealth(host: string, port: number, timeoutMs: number = HEALTHCHECK_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(
      { host: probeHost(host), port, path: "/health", method: "GET", timeout: timeoutMs },
      (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => {
      resolve(false);
    });
    req.end();
  });
}

if (import.meta.main) {
  const env = loadEnv();
  process.exitCode = (await checkHealth(env.HOST, env.PORT)) ? 0 : 1;
}
