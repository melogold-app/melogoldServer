/**
 * Request string sanitization (API §1.4, M12): before validation the server walks **every string of the request
 * body** (values and property names, at any depth), removes `U+0000` and replaces lone surrogates with `U+FFFD`.
 * PostgreSQL would reject both (22021) and turn a client quirk into a 500.
 *
 * The walk is iterative, so a deeply nested body cannot overflow the stack.
 */
import type { FastifyInstance } from "fastify";
import { sanitizeString } from "../lib/strings.ts";

type Container = Record<string, unknown> | unknown[];

function isContainer(value: unknown): value is Container {
  return typeof value === "object" && value !== null;
}

function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  // defineProperty: a key such as "__proto__" stays an ordinary own property.
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

/**
 * Sanitizes a parsed JSON value **in place** and returns it (a top-level string is returned sanitized). When two
 * property names become equal after sanitization, the later one wins.
 */
export function sanitizeJson<T>(value: T): T {
  if (typeof value === "string") return sanitizeString(value) as T;
  if (!isContainer(value)) return value;
  const stack: Container[] = [value];
  const seen = new Set<Container>();
  for (let container = stack.pop(); container !== undefined; container = stack.pop()) {
    if (seen.has(container)) continue;
    seen.add(container);
    if (Array.isArray(container)) {
      for (let index = 0; index < container.length; index++) {
        const item: unknown = container[index];
        if (typeof item === "string") container[index] = sanitizeString(item);
        else if (isContainer(item)) stack.push(item);
      }
      continue;
    }
    const keys = Object.keys(container);
    const entries = keys.map((key): [string, unknown] => {
      const item = container[key];
      const clean = typeof item === "string" ? sanitizeString(item) : item;
      if (isContainer(clean)) stack.push(clean);
      return [sanitizeString(key), clean];
    });
    if (entries.some(([key], index) => key !== keys[index])) {
      // Rebuild in source order, so the later of two names that became equal wins (as in JSON.parse).
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- renaming properties of parsed JSON
      for (const key of keys) delete container[key];
      for (const [key, item] of entries) setOwn(container, key, item);
    } else {
      for (const [key, item] of entries) if (item !== container[key]) container[key] = item;
    }
  }
  return value;
}

/** Sanitizes `request.body` in `preValidation`, before any schema sees it. */
export function registerSanitize(app: FastifyInstance): void {
  app.addHook("preValidation", (request, _reply, done) => {
    if (request.body !== undefined && request.body !== null) request.body = sanitizeJson(request.body);
    done();
  });
}
