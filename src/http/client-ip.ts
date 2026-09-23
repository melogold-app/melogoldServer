/**
 * Client address (API §1.10, DESIGN §8 `TRUST_PROXY`, m17).
 *
 * - `request.ip` honours `X-Forwarded-For` only from the proxies listed in `TRUST_PROXY` (CIDR list in proxy-addr
 *   syntax, never a hop count): {@link trustProxyOption} is the Fastify `trustProxy` option. Empty: XFF is ignored.
 * - The network of a client, used for `ip` rate-limit keys and the "same network" hint of device linking, is the
 *   whole IPv4 address or the IPv6 /56 prefix ({@link clientNet}, `normalizeIP(ip, 56)` of `@fastify/rate-limit`);
 *   IPv4-mapped IPv6 counts as IPv4.
 * - Raw addresses never reach the logs; see `ipTag` in `logging.ts`.
 */
import { normalizeIP } from "@fastify/rate-limit";
import type { FastifyRequest } from "fastify";

export const IPV6_PREFIX_LENGTH = 56;

/** Fastify's `trustProxy`: the CIDR list, or `false` to trust nobody. */
export function trustProxyOption(entries: readonly string[]): false | string[] {
  return entries.length === 0 ? false : [...entries];
}

/** IPv4 as is, IPv6 reduced to its /56 network (lowercase canonical form). */
export function clientNet(ip: string): string {
  try {
    return normalizeIP(ip, IPV6_PREFIX_LENGTH);
  } catch {
    return ip.toLowerCase();
  }
}

/** Whether two addresses are in the same network in the sense of {@link clientNet} (DESIGN §4.10.5). */
export function sameNetwork(a: string, b: string): boolean {
  return clientNet(a) === clientNet(b);
}

/** `ServerInfo.secureTransport`: the request came over https, as seen through a trusted proxy (API §4.2). */
export function isSecureTransport(request: Pick<FastifyRequest, "protocol">): boolean {
  return request.protocol === "https";
}
