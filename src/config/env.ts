/**
 * Server configuration: every variable of API §10, parsed by the pure function {@link parseEnv}.
 *
 * This is the only module that reads `process.env` ({@link loadEnv}); everything else receives the parsed {@link Env}.
 * Rules shared by all variables:
 * - values are trimmed, and an empty value means "not set" (compose passes `PUBLIC_URL=` for an empty default);
 * - unknown variables are ignored;
 * - booleans accept `true|false` (also `1|0`, `yes|no`, `on|off`), case-insensitive;
 * - an invalid value is never replaced by the default: {@link parseEnv} throws {@link EnvError} listing every problem.
 */
import { join } from "node:path";
import { z } from "zod";

// ---------------------------------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------------------------------

export type NodeEnv = "development" | "test" | "production";
export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
export type Registration = "open" | "closed" | "first";
export type SqliteSynchronous = "FULL" | "NORMAL";
export type DatabaseSsl = "disable" | "require" | "verify-full";
export type SchemaCheck = "strict" | "warn";

/** Parsed `DATABASE_URL`. The dialect is chosen by the scheme (DESIGN §6.2). */
export type DatabaseUrl =
  | {
      readonly dialect: "sqlite";
      /** The value as configured, e.g. `sqlite:///data/melogold.db`. */
      readonly url: string;
      /** File path after `sqlite://` (absolute or relative to the working directory), or `:memory:`. */
      readonly path: string;
      /** `sqlite::memory:`: tests and OpenAPI generation only, rejected when `NODE_ENV=production`. */
      readonly memory: boolean;
    }
  | {
      readonly dialect: "postgres";
      /** `postgres://…` or `postgresql://…`, passed to `pg` as the connection string. */
      readonly url: string;
    };

/** Time of day in UTC. */
export type UtcTimeOfDay = { readonly hour: number; readonly minute: number };

/**
 * The parsed environment. Keys are the variable names of API §10; values are validated and converted.
 * Conversions beyond plain parsing are noted per field.
 */
export type Env = Readonly<{
  NODE_ENV: NodeEnv;
  HOST: string;
  PORT: number;

  /** Absolute http(s) base URL without a trailing `/`, normalized (lowercase scheme and host); `null` when unset. */
  PUBLIC_URL: string | null;
  INSTANCE_NAME: string;
  /** Source link for AGPL §13 with `{rev}` already replaced by `GIT_SHA`. */
  SOURCE_URL: string;
  PRIVACY_URL: string | null;
  CONTACT: string | null;

  DATA_DIR: string;
  /** Unset: `sqlite://<DATA_DIR>/melogold.db`, i.e. `sqlite:///data/melogold.db` with the default `DATA_DIR`. */
  DATABASE_URL: DatabaseUrl;
  SQLITE_BUSY_TIMEOUT_MS: number;
  SQLITE_SYNCHRONOUS: SqliteSynchronous;
  DATABASE_POOL_MAX: number;
  DATABASE_SSL: DatabaseSsl;
  DATABASE_SSL_CA_FILE: string | null;
  DATABASE_STATEMENT_TIMEOUT_MS: number;
  MIGRATE_ON_START: boolean;
  SCHEMA_CHECK: SchemaCheck;

  LOG_LEVEL: LogLevel;
  /** proxy-addr entries (IP, IP/prefix, IPv4/netmask, `loopback`, `linklocal`, `uniquelocal`); empty: trust nobody. */
  TRUST_PROXY: readonly string[];
  /** Exact origins (`scheme://host[:port]`); empty: CORS is off except for the public discovery routes. */
  CORS_ORIGINS: readonly string[];
  HTTP_COMPRESSION: boolean;
  OPENAPI_DOCS_UI: boolean;
  SHUTDOWN_GRACE_MS: number;

  /** Lowercase hex of the 32-byte master key; `null`: use `<DATA_DIR>/secret.key` (see `secret-key.ts`). */
  MELOGOLD_SECRET_KEY: string | null;
  ACCESS_TOKEN_TTL_SECONDS: number;
  REFRESH_TOKEN_TTL_DAYS: number;
  REFRESH_GRACE_SECONDS: number;
  RESTORE_REFRESH_GRACE_DAYS: number;
  REGISTRATION: Registration;
  /** 0 disables proof of work. */
  REGISTRATION_POW_BITS: number;
  REGISTRATION_POW_SOFT_PER_HOUR: number;
  /** Normalized like logins (NFKC, trim, lowercase), deduplicated. */
  RESERVED_LOGINS: readonly string[];
  /** `null` = no limit (the variable was `0`), matching `ServerLimits.account.maxDevices`. */
  MAX_DEVICES_PER_USER: number | null;
  DEVICE_INACTIVE_DAYS: number;
  NEW_DEVICE_RESTRICT_HOURS: number;
  LINK_TTL_SECONDS: number;
  LINK_NETWORK_HINT: boolean;
  ARGON2_MEMORY_KIB: number;
  ARGON2_TIME_COST: number;
  ARGON2_PARALLELISM: number;
  ARGON2_MAX_CONCURRENCY: number;
  ARGON2_QUEUE_LIMIT: number;

  SSE_HEARTBEAT_SECONDS: number;
  SSE_MAX_STREAMS_PER_DEVICE: number;
  SSE_MAX_STREAMS_PER_USER: number;
  RATE_LIMIT_ENABLED: boolean;

  HISTORY_RETENTION_DAYS: number;
  HISTORY_MAX_EVENTS: number;
  HISTORY_MERGE_UPLOAD_MAX: number;
  SYNC_OPS_RETENTION_DAYS: number;
  PLAYBACK_RETENTION_DAYS: number;
  RETENTION_RUN_AT_UTC: UtcTimeOfDay;
  DISK_MIN_FREE_PERCENT: number;

  /** Set by the image build (`ARG APP_VERSION=0.0.0-dev`), semver. */
  APP_VERSION: string;
  /** Set by the image build (`ARG GIT_SHA=unknown`): a 7–40 digit hex commit or `unknown`. */
  GIT_SHA: string;
  /** Informational (the image sets `TZ=UTC`); the server works in epoch milliseconds and never depends on it. */
  TZ: string | null;
}>;

/** Variables as they come from the process (`process.env` or a test fixture). */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/** Thrown by {@link parseEnv}. `issues` name the variables but never echo their values (some are secrets). */
export class EnvError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid environment configuration:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.name = "EnvError";
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Defaults and technical bounds
// ---------------------------------------------------------------------------------------------------------------------

export const DEFAULT_DATA_DIR = "/data";
export const DEFAULT_SOURCE_URL = "https://github.com/melogold-app/melogoldServer/tree/{rev}";
export const DEFAULT_APP_VERSION = "0.0.0-dev";
export const DEFAULT_GIT_SHA = "unknown";
const SQLITE_FILE_NAME = "melogold.db";

// API §10 gives no upper bound for these values; the bounds below only keep arithmetic safe
// (day and hour counts converted to milliseconds stay far below 2^53, counts fit in Int32).
const INT32_MAX = 2_147_483_647;
const MAX_DAYS = 36_500;
const MAX_HOURS = MAX_DAYS * 24;
const URL_MAX_LENGTH = 2048;
/** argon2 accepts up to 2^32 − 1 for memory (KiB) and time cost. */
const ARGON2_U32_MAX = 4_294_967_295;

// ---------------------------------------------------------------------------------------------------------------------
// Field schemas
// ---------------------------------------------------------------------------------------------------------------------

function int(defaultValue: number, min: number, max: number) {
  const range = `must be an integer in ${min}..${max}`;
  return z
    .string()
    .regex(/^-?\d{1,16}$/, { error: range })
    .transform(Number)
    .pipe(z.number().int({ error: range }).min(min, { error: range }).max(max, { error: range }))
    .default(defaultValue);
}

function bool(defaultValue: boolean) {
  return z.stringbool({ error: "must be true or false" }).default(defaultValue);
}

function oneOf<const T extends readonly [string, ...string[]]>(values: T, defaultValue: T[number]) {
  return z.enum(values, { error: `must be one of ${values.join("|")}` }).default(defaultValue);
}

/**
 * Length limit in UTF-16 code units (API §1.4). zod 4.6 `.max()` counts Unicode code points, so it is not used for
 * strings anywhere in this project.
 */
function maxUtf16(maxLength: number) {
  return z.string().refine((value) => value.length <= maxLength, {
    error: `must be at most ${maxLength} characters (UTF-16 units)`,
  });
}

function optionalString(maxLength: number) {
  return maxUtf16(maxLength)
    .optional()
    .transform((value) => value ?? null);
}

const httpUrlPattern = /^https?:\/\//;

function isHttpUrl(value: string): boolean {
  if (!httpUrlPattern.test(value) || value.length > URL_MAX_LENGTH) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

const optionalHttpUrl = z
  .string()
  .refine(isHttpUrl, { error: `must be an absolute http(s) URL of at most ${URL_MAX_LENGTH} characters` })
  .optional()
  .transform((value) => value ?? null);

/** Base URL (API §1.1): `scheme://host[:port][/prefix]`, no trailing `/`, no query, fragment or credentials. */
const publicUrl = z
  .string()
  .transform((value, ctx) => {
    const problem = "must be an absolute http(s) URL without a trailing /, query, fragment or credentials";
    if (!isHttpUrl(value) || value.endsWith("/")) {
      ctx.issues.push({ code: "custom", message: problem, input: value });
      return z.NEVER;
    }
    const url = new URL(value);
    if (url.search !== "" || url.hash !== "" || value.includes("?") || value.includes("#")) {
      ctx.issues.push({ code: "custom", message: problem, input: value });
      return z.NEVER;
    }
    if (url.username !== "" || url.password !== "") {
      ctx.issues.push({ code: "custom", message: problem, input: value });
      return z.NEVER;
    }
    return url.pathname === "/" ? url.origin : `${url.origin}${url.pathname}`;
  })
  .optional()
  .transform((value) => value ?? null);

// eslint-disable-next-line no-control-regex -- the point is to reject control characters
const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/;

const instanceName = z
  .string()
  .refine((value) => value.length <= 64, { error: "must be 1..64 characters (UTF-16 units)" })
  .refine((value) => !controlCharacters.test(value), { error: "must not contain control characters" })
  .default("Melogold");

function csv(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

const ipv4Pattern = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const PROXY_ADDR_NAMES = new Set(["loopback", "linklocal", "uniquelocal"]);

function isIPv4(value: string): boolean {
  return ipv4Pattern.test(value);
}

function isIPv6(value: string): boolean {
  if (!value.includes(":") || !/^[0-9A-Fa-f:.]+$/.test(value)) return false;
  try {
    return new URL(`http://[${value}]/`).hostname !== "";
  } catch {
    return false;
  }
}

function isIPv4Netmask(value: string): boolean {
  if (!isIPv4(value)) return false;
  const bits = value
    .split(".")
    .map((octet) => Number(octet).toString(2).padStart(8, "0"))
    .join("");
  return /^1*0*$/.test(bits);
}

/** One `TRUST_PROXY` entry in proxy-addr syntax. */
export function isTrustProxyEntry(entry: string): boolean {
  if (PROXY_ADDR_NAMES.has(entry)) return true;
  const slash = entry.indexOf("/");
  if (slash === -1) return isIPv4(entry) || isIPv6(entry);
  const address = entry.slice(0, slash);
  const range = entry.slice(slash + 1);
  if (isIPv4(address)) {
    if (/^\d{1,2}$/.test(range)) return Number(range) <= 32;
    return isIPv4Netmask(range);
  }
  if (isIPv6(address)) return /^\d{1,3}$/.test(range) && Number(range) <= 128;
  return false;
}

const trustProxy = z
  .string()
  .optional()
  .transform((value, ctx) => {
    const entries = csv(value);
    for (const entry of entries) {
      if (!isTrustProxyEntry(entry)) {
        ctx.issues.push({
          code: "custom",
          message: `"${entry}" is not an IP, CIDR or proxy-addr name (loopback, linklocal, uniquelocal)`,
          input: value,
        });
      }
    }
    return [...new Set(entries)];
  });

function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
  } catch {
    return false;
  }
}

const corsOrigins = z
  .string()
  .optional()
  .transform((value, ctx) => {
    const origins = csv(value);
    for (const origin of origins) {
      if (!isOrigin(origin)) {
        ctx.issues.push({
          code: "custom",
          message: `"${origin}" is not an origin (scheme://host[:port], lowercase, no path or trailing /)`,
          input: value,
        });
      }
    }
    return [...new Set(origins)];
  });

/** Same normalization as logins (API §1.6): NFKC, trim, lowercase. */
export function normalizeLogin(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

const reservedLogins = z
  .string()
  .optional()
  .transform((value) => [
    ...new Set(
      csv(value)
        .map(normalizeLogin)
        .filter((login) => login !== ""),
    ),
  ]);

const secretKeyHex = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, { error: "must be 64 hex characters (32 bytes)" })
  .transform((value) => value.toLowerCase())
  .optional()
  .transform((value) => value ?? null);

const retentionRunAt = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, { error: "must be HH:MM (UTC, 00:00..23:59)" })
  .default("04:30")
  .transform((value): UtcTimeOfDay => ({ hour: Number(value.slice(0, 2)), minute: Number(value.slice(3, 5)) }));

const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

// ---------------------------------------------------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------------------------------------------------

const envSchema = z.object({
  NODE_ENV: oneOf(["development", "test", "production"], "production"),
  HOST: z.string().default("127.0.0.1"),
  PORT: int(8080, 1, 65_535),

  PUBLIC_URL: publicUrl,
  INSTANCE_NAME: instanceName,
  SOURCE_URL: z
    .string()
    .refine((value) => isHttpUrl(value.replaceAll("{rev}", "0")), {
      error: "must be an absolute http(s) URL; {rev} is replaced by GIT_SHA",
    })
    .default(DEFAULT_SOURCE_URL),
  PRIVACY_URL: optionalHttpUrl,
  CONTACT: optionalString(URL_MAX_LENGTH),

  DATA_DIR: z
    .string()
    .refine((value) => !value.includes("\0"), { error: "must be a path" })
    .default(DEFAULT_DATA_DIR),
  DATABASE_URL: z.string().optional(),
  SQLITE_BUSY_TIMEOUT_MS: int(5000, 100, 60_000),
  SQLITE_SYNCHRONOUS: oneOf(["FULL", "NORMAL"], "FULL"),
  DATABASE_POOL_MAX: int(10, 1, 50),
  DATABASE_SSL: oneOf(["disable", "require", "verify-full"], "disable"),
  DATABASE_SSL_CA_FILE: optionalString(4096),
  DATABASE_STATEMENT_TIMEOUT_MS: int(15_000, 1, INT32_MAX),
  MIGRATE_ON_START: bool(true),
  SCHEMA_CHECK: oneOf(["strict", "warn"], "strict"),

  LOG_LEVEL: oneOf(["fatal", "error", "warn", "info", "debug", "trace", "silent"], "info"),
  TRUST_PROXY: trustProxy,
  CORS_ORIGINS: corsOrigins,
  HTTP_COMPRESSION: bool(true),
  OPENAPI_DOCS_UI: bool(false),
  SHUTDOWN_GRACE_MS: int(10_000, 0, INT32_MAX),

  MELOGOLD_SECRET_KEY: secretKeyHex,
  ACCESS_TOKEN_TTL_SECONDS: int(900, 300, 3600),
  REFRESH_TOKEN_TTL_DAYS: int(90, 7, 365),
  REFRESH_GRACE_SECONDS: int(86_400, 60, 604_800),
  RESTORE_REFRESH_GRACE_DAYS: int(3, 0, 14),
  REGISTRATION: oneOf(["open", "closed", "first"], "first"),
  REGISTRATION_POW_BITS: int(0, 0, 26),
  REGISTRATION_POW_SOFT_PER_HOUR: int(60, 1, INT32_MAX),
  RESERVED_LOGINS: reservedLogins,
  MAX_DEVICES_PER_USER: int(20, 0, INT32_MAX).transform((value) => (value === 0 ? null : value)),
  DEVICE_INACTIVE_DAYS: int(180, 1, MAX_DAYS),
  NEW_DEVICE_RESTRICT_HOURS: int(24, 0, MAX_HOURS),
  LINK_TTL_SECONDS: int(300, 60, 900),
  LINK_NETWORK_HINT: bool(true),
  ARGON2_MEMORY_KIB: int(65_536, 19_456, ARGON2_U32_MAX),
  ARGON2_TIME_COST: int(3, 2, ARGON2_U32_MAX),
  ARGON2_PARALLELISM: int(1, 1, 4),
  ARGON2_MAX_CONCURRENCY: int(2, 1, INT32_MAX),
  ARGON2_QUEUE_LIMIT: int(32, 0, INT32_MAX),

  SSE_HEARTBEAT_SECONDS: int(25, 5, 60),
  SSE_MAX_STREAMS_PER_DEVICE: int(4, 1, INT32_MAX),
  SSE_MAX_STREAMS_PER_USER: int(64, 1, INT32_MAX),
  RATE_LIMIT_ENABLED: bool(true),

  HISTORY_RETENTION_DAYS: int(400, 366, MAX_DAYS),
  HISTORY_MAX_EVENTS: int(50_000, 1, INT32_MAX),
  HISTORY_MERGE_UPLOAD_MAX: int(20_000, 1, INT32_MAX),
  SYNC_OPS_RETENTION_DAYS: int(180, 30, MAX_DAYS),
  PLAYBACK_RETENTION_DAYS: int(30, 1, MAX_DAYS),
  RETENTION_RUN_AT_UTC: retentionRunAt,
  DISK_MIN_FREE_PERCENT: int(10, 1, 50),

  APP_VERSION: z.string().regex(semver, { error: "must be a semver version" }).default(DEFAULT_APP_VERSION),
  GIT_SHA: z
    .string()
    .regex(/^([0-9a-f]{7,40}|unknown)$/, { error: "must be a 7..40 digit lowercase hex commit or 'unknown'" })
    .default(DEFAULT_GIT_SHA),
  TZ: optionalString(256),
});

type ParsedFields = z.output<typeof envSchema>;

// ---------------------------------------------------------------------------------------------------------------------
// DATABASE_URL
// ---------------------------------------------------------------------------------------------------------------------

const DATABASE_URL_PROBLEM = "must be sqlite://<path>, sqlite::memory:, postgres://… or postgresql://…";

/** Parses a `DATABASE_URL` value; returns an error message instead of throwing. */
export function parseDatabaseUrl(value: string): DatabaseUrl | { readonly error: string } {
  if (value === "sqlite::memory:") {
    return { dialect: "sqlite", url: value, path: ":memory:", memory: true };
  }
  if (value.startsWith("sqlite://")) {
    const path = value.slice("sqlite://".length);
    if (path === "" || path.includes("\0")) return { error: DATABASE_URL_PROBLEM };
    return { dialect: "sqlite", url: value, path, memory: false };
  }
  if (value.startsWith("postgres://") || value.startsWith("postgresql://")) {
    try {
      new URL(value);
    } catch {
      return { error: "is not a valid postgres:// URL (percent-encode special characters in the password)" };
    }
    return { dialect: "postgres", url: value };
  }
  return { error: DATABASE_URL_PROBLEM };
}

// ---------------------------------------------------------------------------------------------------------------------
// parseEnv
// ---------------------------------------------------------------------------------------------------------------------

function normalizeSource(source: EnvSource): Record<string, string | undefined> {
  const normalized: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const trimmed = value.trim();
    normalized[key] = trimmed === "" ? undefined : trimmed;
  }
  return normalized;
}

function finalize(fields: ParsedFields, issues: string[]): Env {
  const databaseUrlValue = fields.DATABASE_URL ?? `sqlite://${join(fields.DATA_DIR, SQLITE_FILE_NAME)}`;
  const database = parseDatabaseUrl(databaseUrlValue);
  if ("error" in database) {
    issues.push(`DATABASE_URL: ${database.error}`);
  } else if (database.dialect === "sqlite" && database.memory && fields.NODE_ENV === "production") {
    issues.push("DATABASE_URL: sqlite::memory: is for tests and OpenAPI generation only (NODE_ENV=production)");
  }

  if (fields.HISTORY_MERGE_UPLOAD_MAX > fields.HISTORY_MAX_EVENTS) {
    issues.push("HISTORY_MERGE_UPLOAD_MAX: must not exceed HISTORY_MAX_EVENTS");
  }

  const sourceUrl = fields.SOURCE_URL.replaceAll("{rev}", fields.GIT_SHA);

  if (issues.length > 0 || "error" in database) throw new EnvError(issues);

  return Object.freeze({
    ...fields,
    SOURCE_URL: sourceUrl,
    DATABASE_URL: Object.freeze(database),
    TRUST_PROXY: Object.freeze(fields.TRUST_PROXY),
    CORS_ORIGINS: Object.freeze(fields.CORS_ORIGINS),
    RESERVED_LOGINS: Object.freeze(fields.RESERVED_LOGINS),
    RETENTION_RUN_AT_UTC: Object.freeze(fields.RETENTION_RUN_AT_UTC),
  });
}

/**
 * Parses and validates the server environment (API §10). Pure: no I/O, no `process` access, the same input always
 * gives the same output.
 *
 * @throws {EnvError} listing every invalid variable.
 */
export function parseEnv(source: EnvSource): Env {
  const result = envSchema.safeParse(normalizeSource(source));
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const key = issue.path.map(String).join(".") || "(environment)";
      return `${key}: ${issue.message}`;
    });
    throw new EnvError(issues);
  }
  return finalize(result.data, []);
}

/** Reads `process.env` (allowed only in this module) and parses it. */
export function loadEnv(): Env {
  return parseEnv(process.env);
}
