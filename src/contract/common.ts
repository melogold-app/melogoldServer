/**
 * Contract building blocks (API §1.3–§1.6, §2.1) and the shared DTOs of API §4.1. Frozen after M0 (PLAN, general
 * rules item 2): a change starts with an edit of `docs/API.md`.
 *
 * **Conventions of every file under `src/contract`:**
 * - Every body and every nested object is a named schema, `.meta({ id })`, with the type name of API §4/§6/§11
 *   (the OpenAPI component). Objects that API.md writes inline get a name too (listed in `index.ts`), because
 *   API §1.1 forbids inline schemas.
 * - **Requests are validated.** A `?` field may be absent or `null`, and both come out as `undefined`
 *   ({@link optional}). Unknown keys are dropped (API §1.3). String lengths count UTF-16 units ({@link text}: zod's
 *   `.min`/`.max` count code points). Integers are safe integers, `Int32` where the API says so. Enumerations are
 *   `enum`. Times become epoch milliseconds ({@link Iso}).
 * - **Responses are checked for structure only** when Fastify serializes them: keys, `null`, types, integers.
 *   Formats and lengths are documented in OpenAPI but not re-checked on the way out (a stored value that breaks a
 *   documented format must not turn a whole `/sync` page into a 500). Enumerations are `type: string` with the
 *   values in `description` (API §1.3: clients survive unknown values); the `*_VALUES` arrays give services the
 *   typed values.
 * - Strings of request bodies are sanitized before validation (NUL removed, lone surrogates replaced, API §1.4).
 */
import { z } from "zod";
import { UUID_PATTERN } from "../lib/ids.ts";
import { cleanDeviceName, utf8ByteLength } from "../lib/strings.ts";
import { ISO_INPUT_PATTERN, parseIso } from "../lib/time.ts";
import {
  INT32_MAX,
  LOGIN_INPUT_MAX_LENGTH,
  PASSWORD_LIMITS,
  PASSWORD_MAX_UTF8_BYTES,
  STRING_LIMITS,
} from "./limits.ts";

// ---------------------------------------------------------------------------------------------------------------------
// Formats (API §1.5, §1.6)
// ---------------------------------------------------------------------------------------------------------------------

export { UUID_PATTERN };
export const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
export const BROWSE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const HTTP_URL_PATTERN = /^https?:\/\//;
export const HWID_PATTERN = /^[0-9a-f]{64}$/;
export const PLATFORM_PATTERN = /^[a-z0-9_]{1,16}$/;
/** `""` (both streams from zero) or `<epoch 8 hex>.<libSeq>.<histSeq>`. */
export const CURSOR_PATTERN = /^(?:[0-9a-f]{8}\.[0-9]{1,16}\.[0-9]{1,16})?$/;
export const VERIFY_CODE_PATTERN = /^[0-9]{2}$/;
export const LINK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const POLL_SECRET_PATTERN = /^mgps_[A-Za-z0-9_-]{43}$/;
export const REFRESH_TOKEN_PATTERN = /^mgrt1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
export const REFRESH_TOKEN_MAX_LENGTH = 1024;
export const POW_CHALLENGE_PATTERN = /^mgpow1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
export const POW_CHALLENGE_MAX_LENGTH = 256;
export const POW_NONCE_PATTERN = /^[0-9]{1,16}$/;
export const VIDEO_TYPE_PATTERN = /^[a-z_]{1,32}$/;
/** What the server sends (API §1.5): always three fraction digits. */
export const ISO_OUTPUT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export { ISO_INPUT_PATTERN };

/** Crockford Base32 (API §1.6 `RecoveryCode`, `UserCode`). */
export const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const RECOVERY_CODE_LENGTH = 20;
export const USER_CODE_LENGTH = 8;
/** Output forms of API §1.6: `XXXX-XXXX` and `XXXX-XXXX-XXXX-XXXX-XXXX` of {@link CROCKFORD_ALPHABET}. */
export const USER_CODE_OUTPUT_PATTERN = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
export const RECOVERY_CODE_OUTPUT_PATTERN = /^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){4}$/;

export function isHttpUrl(value: string): boolean {
  return HTTP_URL_PATTERN.test(value) && value.length <= STRING_LIMITS.url;
}

/**
 * Input rule of API §1.6 `RecoveryCode` / `UserCode`: upper case; spaces, `-` and `_` removed; `O→0`, `I,L→1`;
 * exactly `length` characters of {@link CROCKFORD_ALPHABET}.
 * @returns the normalized code without separators, or `null` when it is not a code.
 */
export function normalizeCrockfordCode(input: string, length: number): string | null {
  const code = input
    .toUpperCase()
    .replace(/[\s_-]/g, "")
    .replaceAll("O", "0")
    .replace(/[IL]/g, "1");
  if (code.length !== length) return null;
  for (const char of code) if (!CROCKFORD_ALPHABET.includes(char)) return null;
  return code;
}

/** The output form of API §1.6: groups of four joined by `-` (`XXXX-XXXX`, `XXXX-XXXX-XXXX-XXXX-XXXX`). */
export function formatCodeGroups(code: string): string {
  return (code.match(/.{1,4}/g) ?? []).join("-");
}

// ---------------------------------------------------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------------------------------------------------

/** A request string of `min..max` **UTF-16 units** (API §1.4). Issues are zod's `too_small` / `too_big`. */
export function text(min: number, max: number) {
  return z
    .string()
    .check((ctx) => {
      const length = ctx.value.length;
      if (length > max) {
        ctx.issues.push({ code: "too_big", origin: "string", maximum: max, inclusive: true, input: ctx.value });
      } else if (length < min) {
        ctx.issues.push({ code: "too_small", origin: "string", minimum: min, inclusive: true, input: ctx.value });
      }
    })
    .meta(min > 0 ? { minLength: min, maxLength: max } : { maxLength: max });
}

/** A request string matching `pattern` (issue `invalid_format`), documented with the same pattern. */
export function matching(pattern: RegExp) {
  return z.string().regex(pattern);
}

/**
 * A `?` request field (API §1.3): absent and `null` are both accepted and come out as `undefined`, so services test
 * one value only.
 */
export function optional<T extends z.ZodType>(schema: T) {
  return schema.nullish().transform((value) => value ?? undefined);
}

/** A request integer in `min..max` (API §1.4: integers only, never above 2^53 − 1). */
export function int(min: number, max: number = Number.MAX_SAFE_INTEGER) {
  return z.int().min(min).max(max);
}

// ---------------------------------------------------------------------------------------------------------------------
// Request primitives (API §1.5, §1.6)
// ---------------------------------------------------------------------------------------------------------------------

export const Uuid = matching(UUID_PATTERN).meta({ description: "UUID, lowercase only (API §1.6)." });
export const VideoId = matching(VIDEO_ID_PATTERN).meta({ description: "Any YouTube video id (API §1.6)." });
export const BrowseId = matching(BROWSE_ID_PATTERN).meta({
  description: "Album, artist, channel (`UC…`) or playlist browseId (API §1.6).",
});

/**
 * API §1.5 input time: `YYYY-MM-DDTHH:mm:ss(.f{1,9})?Z` in [2000-01-01, 2100-01-01), the fraction truncated to
 * milliseconds. **Comes out as epoch milliseconds.**
 */
export const Iso = z
  .string()
  .transform((value, ctx) => {
    const time = parseIso(value);
    if (time === null) {
      ctx.issues.push({ code: "invalid_format", format: "datetime", input: value });
      return z.NEVER;
    }
    return time;
  })
  .meta({
    format: "date-time",
    pattern: ISO_INPUT_PATTERN.source,
    description: "UTC time with `Z`, 0–9 fraction digits (truncated to ms), in [2000-01-01, 2100-01-01) (API §1.5).",
  });

export const Cursor = matching(CURSOR_PATTERN).meta({
  description: '`""` (both streams from zero) or an opaque cursor from a previous response (API §1.6).',
});

export const Hwid = matching(HWID_PATTERN).meta({
  description: 'hex(sha256("melogold-hwid-v1|" + platformId + "|" + serverId)) (API §1.6).',
});

export const Platform = matching(PLATFORM_PATTERN).meta({
  description: "Known values: android, macos, windows, linux, other. Stored as sent (API §1.6).",
});

/**
 * API §1.6 `DeviceName`: C0/C1 controls, U+200E/U+200F, U+202A–U+202E and U+2066–U+2069 removed, whitespace runs
 * collapsed, trimmed; then 1..64 UTF-16 units. **Comes out cleaned.**
 */
export const DeviceName = z.string().transform(cleanDeviceName).pipe(text(1, STRING_LIMITS.deviceName)).meta({
  minLength: 1,
  maxLength: STRING_LIMITS.deviceName,
  description:
    "Cleaned by the server (controls and bidi marks removed, spaces collapsed, trimmed); 1..64 after cleaning.",
});

/** API §1.6 `Login` on input: 1..64 UTF-16 units; the service normalizes (NFKC → trim → lowercase). */
export const Login = text(1, LOGIN_INPUT_MAX_LENGTH).meta({
  description:
    "1..64 on input; normalized NFKC → trim → lowercase. A new login must match the pattern of `limits.account.login`.",
});

/** API §1.6: a password that is checked (login, reauth): 1..128 UTF-16 units and at most 512 UTF-8 bytes. */
export const CheckedPassword = text(1, PASSWORD_LIMITS.maxLength)
  .check((ctx) => {
    if (utf8ByteLength(ctx.value) > PASSWORD_MAX_UTF8_BYTES) {
      ctx.issues.push({
        code: "too_big",
        origin: "string",
        maximum: PASSWORD_MAX_UTF8_BYTES,
        inclusive: true,
        input: ctx.value,
        message: "Too big: expected at most 512 UTF-8 bytes",
      });
    }
  })
  .meta({ description: "1..128 UTF-16 units and at most 512 UTF-8 bytes; NFKC before verification." });

/**
 * API §1.6: a **new** password. The schema accepts any string: the password policy answers with its own codes
 * (`password_too_short{minLength}`, `password_too_long{maxLength}`, `password_too_common`, `password_contains_login`),
 * not with `invalid_request`.
 */
export const NewPassword = z.string().meta({
  minLength: PASSWORD_LIMITS.minLength,
  maxLength: PASSWORD_LIMITS.maxLength,
  description:
    "8..128 UTF-16 units and at most 512 UTF-8 bytes, not too common, without the login; NFKC before hashing. Violations answer `password_*` codes.",
});

/** API §1.6 `RecoveryCode` on input. **Comes out normalized: 20 characters, no separators.** */
export const RecoveryCodeInput = z
  .string()
  .transform((value, ctx) => {
    const code = normalizeCrockfordCode(value, RECOVERY_CODE_LENGTH);
    if (code === null) {
      ctx.issues.push({ code: "invalid_format", format: "regex", input: value });
      return z.NEVER;
    }
    return code;
  })
  .meta({
    description:
      "Crockford Base32, shown as XXXX-XXXX-XXXX-XXXX-XXXX. Input: case-insensitive; spaces, `-`, `_` ignored; O→0, I and L→1; exactly 20 characters.",
  });

/** API §1.6 `UserCode` on input. **Comes out normalized: 8 characters, no separators.** */
export const UserCodeInput = z
  .string()
  .transform((value, ctx) => {
    const code = normalizeCrockfordCode(value, USER_CODE_LENGTH);
    if (code === null) {
      ctx.issues.push({ code: "invalid_format", format: "regex", input: value });
      return z.NEVER;
    }
    return code;
  })
  .meta({
    description:
      "Crockford Base32, shown as XXXX-XXXX. Input: case-insensitive; spaces, `-`, `_` ignored; O→0, I and L→1; exactly 8 characters.",
  });

export const VerifyCode = matching(VERIFY_CODE_PATTERN).meta({ description: "Two digits (API §1.6)." });
export const LinkToken = matching(LINK_TOKEN_PATTERN).meta({ description: "43 characters of base64url (API §1.6)." });
export const PollSecret = matching(POLL_SECRET_PATTERN).meta({ description: "`mgps_` + 43 characters (API §1.6)." });

/**
 * API §1.6 `RefreshToken`. Not checked by the schema: a malformed token must reach the service and answer
 * `401 invalid_refresh_token` (refresh) or `204` (logout, API §4.3), never `400`, so that the client drops it.
 */
export const RefreshToken = z.string().meta({
  maxLength: REFRESH_TOKEN_MAX_LENGTH,
  pattern: REFRESH_TOKEN_PATTERN.source,
  description: "`mgrt1.<b64url>.<b64url>`, up to 1024 characters. A malformed token answers like an invalid one.",
});

export const PowChallenge = text(1, POW_CHALLENGE_MAX_LENGTH)
  .regex(POW_CHALLENGE_PATTERN)
  .meta({ description: "`mgpow1.<b64url>.<b64url>`, up to 256 characters." });

export const PowNonce = matching(POW_NONCE_PATTERN).meta({ description: 'Decimal digits: "0", "1", … (API §4.3).' });

// ---------------------------------------------------------------------------------------------------------------------
// Response helpers: structure is checked, formats are documented (see the module comment)
// ---------------------------------------------------------------------------------------------------------------------

/** A response string documented with `maxLength` (and `minLength` when above 0). */
export function textOut(maxLength: number, minLength = 0) {
  return z.string().meta(minLength > 0 ? { minLength, maxLength } : { maxLength });
}

/**
 * A response enumeration: `type: string` with the known values in `description` (API §1.3). The TS type stays
 * `string`: services pass values from the matching `*_VALUES` array.
 */
export function enumOut(values: readonly string[], description?: string) {
  const known = `Known values: ${values.join(", ")}. Clients must accept unknown values (API §1.3).`;
  return z.string().meta({ description: description === undefined ? known : `${description} ${known}` });
}

export const UuidOut = z.string().meta({ pattern: UUID_PATTERN.source, description: "UUID, lowercase." });
export const VideoIdOut = z.string().meta({ pattern: VIDEO_ID_PATTERN.source, description: "YouTube video id." });
export const BrowseIdOut = z.string().meta({ pattern: BROWSE_ID_PATTERN.source, description: "browseId." });
export const IsoOut = z.string().meta({
  format: "date-time",
  pattern: ISO_OUTPUT_PATTERN.source,
  description: "UTC, always `YYYY-MM-DDTHH:mm:ss.sssZ` (API §1.5).",
});
export const CursorOut = z.string().meta({ description: "Opaque cursor (API §1.6)." });
export const HttpUrlOut = z.string().meta({ maxLength: STRING_LIMITS.url, pattern: HTTP_URL_PATTERN.source });
/** A response integer (API §1.4: integers only, at most 2^53 − 1). */
export const IntOut = z.int();
/** A response `Int32`. */
export const Int32Out = z.int().meta({ maximum: INT32_MAX });

// ---------------------------------------------------------------------------------------------------------------------
// Errors (API §2.1)
// ---------------------------------------------------------------------------------------------------------------------

export const ValidationIssue = z
  .object({
    path: z.string().meta({ description: 'Dot path into the request, e.g. "ops.3.opId".' }),
    code: z.string().meta({ description: "zod issue code, e.g. invalid_type, too_big, invalid_format." }),
  })
  .meta({ id: "ValidationIssue" });

export const ErrorResponse = z
  .object({
    statusCode: IntOut,
    error: z.string().meta({ description: "Same text as `message` (Clementine shape)." }),
    message: z.string().meta({
      description: "English text for logs; not for UI or logic. 5xx always carry the generic text of their code.",
    }),
    code: z.string().meta({
      description:
        "The only field clients branch on (API §2.2, `error-codes.json`). Clients must accept unknown codes.",
    }),
    retryAfterSeconds: IntOut.optional(),
    issues: z.array(ValidationIssue).optional(),
    minLength: IntOut.optional(),
    maxLength: IntOut.optional(),
    deviceLimit: IntOut.optional(),
    deviceCount: IntOut.optional(),
    minProtocol: IntOut.optional(),
    maxProtocol: IntOut.optional(),
    floorCursor: CursorOut.optional(),
    minDeviceAgeDays: IntOut.optional(),
  })
  .meta({
    id: "ErrorResponse",
    description: "Every refusal (API §2.1). Details appear only with their codes.",
  });

// ---------------------------------------------------------------------------------------------------------------------
// Shared DTOs (API §4.1)
// ---------------------------------------------------------------------------------------------------------------------

export const ArtistRef = z
  .object({
    id: BrowseIdOut.nullable(),
    name: textOut(STRING_LIMITS.artistName, 1),
  })
  .meta({ id: "ArtistRef" });

export const TrackDto = z
  .object({
    videoId: VideoIdOut,
    title: textOut(STRING_LIMITS.title, 1).meta({ description: "`videoId` when `metadataStub`." }),
    artistsText: textOut(STRING_LIMITS.title).nullable().meta({ description: "For a plain video: the channel name." }),
    artists: z.array(ArtistRef).meta({
      maxItems: STRING_LIMITS.trackArtists,
      description: 'For a plain video: [{id: "UC…", name: <channel>}] or [].',
    }),
    albumId: BrowseIdOut.nullable(),
    albumTitle: textOut(STRING_LIMITS.title).nullable(),
    durationMs: Int32Out.nullable().meta({ description: "`null`: unknown or live." }),
    durationText: textOut(STRING_LIMITS.durationText).nullable().meta({ description: '"3:33", "1:02:03".' }),
    thumbnailUrl: HttpUrlOut.nullable(),
    explicit: z.boolean(),
    videoType: z.string().nullable().meta({
      maxLength: STRING_LIMITS.videoType,
      pattern: VIDEO_TYPE_PATTERN.source,
      description: "song, video, ugc, live, podcast_episode, … Not an enumeration.",
    }),
    metadataStub: z.boolean().meta({ description: "`true`: no metadata (title = videoId)." }),
  })
  .meta({ id: "TrackDto", description: "A track is any YouTube video (DESIGN §3.3)." });

/** `$ref` to a component, for documenting fields whose value the schema does not check ({@link TrackInput}). */
function componentRef(id: string): { $ref: string } {
  return { $ref: `#/components/schemas/${id}` };
}

/** A metadata field parsed leniently by the service (DESIGN §3.9): any value passes the schema. */
function lenient(doc: Readonly<Record<string, unknown>>, description: string) {
  return z
    .unknown()
    .optional()
    .meta({ ...doc, description: `${description} Parsed leniently: an invalid value becomes null (DESIGN §3.9).` });
}

/**
 * API §4.1 `TrackInput`. Only `videoId` is checked by the schema (`PUT /playback/state` answers 400 for a bad one;
 * `/sync` does not validate op fields on the route at all). Every metadata field passes as `unknown` and is cleaned
 * field by field by the service (DESIGN §3.9: truncated, invalid → null, empty title → stub, bad `artists` items
 * dropped); OpenAPI still documents the expected types.
 */
export const TrackInput = z
  .object({
    videoId: VideoId,
    title: lenient({ type: "string", maxLength: STRING_LIMITS.title }, "Empty → metadata stub; truncated to 500."),
    artistsText: lenient({ type: "string", maxLength: STRING_LIMITS.title }, "Truncated to 500."),
    artists: lenient(
      { type: "array", maxItems: STRING_LIMITS.trackArtists, items: componentRef("ArtistRef") },
      "Invalid items are dropped.",
    ),
    albumId: lenient({ type: "string", pattern: BROWSE_ID_PATTERN.source }, "BrowseId."),
    albumTitle: lenient({ type: "string", maxLength: STRING_LIMITS.title }, "Truncated to 500."),
    durationMs: lenient({ type: "integer", maximum: INT32_MAX }, "Int32."),
    durationText: lenient({ type: "string", maxLength: STRING_LIMITS.durationText }, '"3:33", "1:02:03".'),
    thumbnailUrl: lenient(
      { type: "string", maxLength: STRING_LIMITS.url, pattern: HTTP_URL_PATTERN.source },
      "HttpUrl.",
    ),
    explicit: lenient({ type: "boolean" }, "Boolean."),
    videoType: lenient(
      { type: "string", maxLength: STRING_LIMITS.videoType, pattern: VIDEO_TYPE_PATTERN.source },
      "song, video, ugc, live, podcast_episode, …",
    ),
  })
  .meta({ id: "TrackInput", description: "Track metadata sent by a client (lenient parsing, DESIGN §3.9)." });

export const DeviceInput = z
  .object({
    hwid: Hwid,
    name: DeviceName,
    platform: Platform,
    osVersion: optional(text(0, STRING_LIMITS.deviceField)),
    model: optional(text(0, STRING_LIMITS.deviceField)),
    clientVersion: optional(text(0, STRING_LIMITS.deviceField)),
  })
  .meta({ id: "DeviceInput" });

export const DevicePatch = z
  .object({
    hwid: Hwid,
    name: optional(DeviceName),
    osVersion: optional(text(0, STRING_LIMITS.deviceField)),
    model: optional(text(0, STRING_LIMITS.deviceField)),
    clientVersion: optional(text(0, STRING_LIMITS.deviceField)),
  })
  .meta({ id: "DevicePatch", description: "Refresh: `hwid` is required, other fields only when they changed." });

/** API §4.1 `DeviceDto.linkedVia`. */
export const LINKED_VIA_VALUES = ["register", "login", "link", "recovery"] as const;
export type LinkedVia = (typeof LINKED_VIA_VALUES)[number];

export const DeviceDto = z
  .object({
    id: UuidOut,
    name: textOut(STRING_LIMITS.deviceName, 1).meta({ description: "customName ?? reportedName." }),
    reportedName: textOut(STRING_LIMITS.deviceName, 1),
    customName: textOut(STRING_LIMITS.deviceName, 1).nullable(),
    platform: z.string().meta({ pattern: PLATFORM_PATTERN.source }),
    osVersion: textOut(STRING_LIMITS.deviceField).nullable(),
    model: textOut(STRING_LIMITS.deviceField).nullable(),
    clientVersion: textOut(STRING_LIMITS.deviceField).nullable(),
    linkedVia: enumOut(LINKED_VIA_VALUES),
    linkedByDeviceId: UuidOut.nullable(),
    createdAt: IsoOut,
    lastSeenAt: IsoOut,
    lastSyncAt: IsoOut.nullable(),
    recentUntil: IsoOut.nullable().meta({
      description: "Until this moment the device is new (DESIGN §4.8), otherwise null.",
    }),
    isCurrent: z.boolean(),
  })
  .meta({ id: "DeviceDto" });

export const RecoveryCodeStatus = z
  .object({ createdAt: IsoOut, confirmed: z.boolean() })
  .meta({ id: "RecoveryCodeStatus" });

export const UserDto = z
  .object({
    id: UuidOut,
    login: z.string(),
    createdAt: IsoOut,
    passwordChangedAt: IsoOut,
    recoveryCodeStatus: RecoveryCodeStatus,
  })
  .meta({ id: "UserDto" });

export const TokenPair = z
  .object({
    accessToken: z.string(),
    accessTokenExpiresAt: IsoOut,
    refreshToken: z.string().meta({ maxLength: REFRESH_TOKEN_MAX_LENGTH, pattern: REFRESH_TOKEN_PATTERN.source }),
    refreshTokenExpiresAt: IsoOut,
  })
  .meta({ id: "TokenPair" });

export const AuthSession = z
  .object({
    user: UserDto,
    device: DeviceDto,
    tokens: TokenPair,
    serverId: UuidOut,
    serverTime: IsoOut,
    recoveryCode: z.string().nullable().meta({
      pattern: RECOVERY_CODE_OUTPUT_PATTERN.source,
      description: "Only register and recover: XXXX-XXXX-XXXX-XXXX-XXXX.",
    }),
    signedOutDevices: IntOut.meta({ description: "recover: how many devices were removed; otherwise 0." }),
  })
  .meta({ id: "AuthSession", description: "register, login, recover, completed device link (poll)." });

export type ArtistRef = z.output<typeof ArtistRef>;
export type TrackDto = z.output<typeof TrackDto>;
export type TrackInput = z.output<typeof TrackInput>;
export type DeviceInput = z.output<typeof DeviceInput>;
export type DevicePatch = z.output<typeof DevicePatch>;
export type DeviceDto = z.output<typeof DeviceDto>;
export type RecoveryCodeStatus = z.output<typeof RecoveryCodeStatus>;
export type UserDto = z.output<typeof UserDto>;
export type TokenPair = z.output<typeof TokenPair>;
export type AuthSession = z.output<typeof AuthSession>;
export type ErrorResponse = z.output<typeof ErrorResponse>;
