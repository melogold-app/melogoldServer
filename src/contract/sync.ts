/**
 * API §4.7 (summary, merge plan) and §4.8 (`POST /sync`).
 *
 * **Two request schemas for `POST /sync`** (DESIGN §3.9):
 * - {@link SyncRequest} with the flat, typed {@link SyncOp} is the source of OpenAPI and of the client types. It is
 *   **never used to validate**: a bad op field must not fail the whole batch.
 * - {@link SyncRequestEnvelope} is what the route validates: the envelope, and per op only `opId`, `kind`, `at`,
 *   `base` plus unique `opId`s. The other op fields pass through untouched ({@link SyncOpEnvelope} is a loose object)
 *   and each op handler parses them itself (`src/modules/sync/ops`). The work budget
 *   Σ(`videoIds` + `entries` + `tracks`) ≤ 20 000 answers `413`, so it is checked by the service, not here.
 *
 * `SyncSummary.counts` is written inline in API.md; it is the named component `SyncSummaryCounts` here.
 */
import { z } from "zod";
import { OP_RESULT_CODES } from "../http/error-codes.ts";
import {
  BrowseId,
  BrowseIdOut,
  Cursor,
  CursorOut,
  enumOut,
  HttpUrlOut,
  int,
  intRange,
  IntOut,
  Iso,
  IsoOut,
  optional,
  text,
  textOut,
  TrackDto,
  TrackInput,
  Uuid,
  UuidOut,
  VIDEO_ID_PATTERN,
  VideoId,
  VideoIdOut,
} from "./common.ts";
import { MERGE_PLAN_LIMITS, STRING_LIMITS, SYNC_LIMITS } from "./limits.ts";

// ---------------------------------------------------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------------------------------------------------

export const SYNC_STREAM_VALUES = ["library", "history"] as const;
export type SyncStream = (typeof SYNC_STREAM_VALUES)[number];

export const OP_STATUS_VALUES = ["applied", "superseded", "redirected", "rejected", "deferred"] as const;
export type OpStatus = (typeof OP_STATUS_VALUES)[number];

export const MERGE_ACTION_VALUES = ["merge", "deleted", "create"] as const;
export type MergeAction = (typeof MERGE_ACTION_VALUES)[number];

export const BOOKMARK_TYPE_VALUES = ["album", "artist"] as const;
export type BookmarkType = (typeof BOOKMARK_TYPE_VALUES)[number];

/** `play.baseline.mode`. */
export const BASELINE_MODE_VALUES = ["add", "atLeast"] as const;
export type BaselineMode = (typeof BASELINE_MODE_VALUES)[number];

/** `PlayForgetRow.videoId` of the whole-history watermark (`history.clear`). */
export const ALL_VIDEOS = "*";

/** Longest `SyncOp.kind` and `SyncOp.base` (DESIGN §3.9). */
export const OP_KIND_MAX_LENGTH = 64;
export const OP_BASE_MAX_LENGTH = 64;

/** `play.add.playTimeMs` is 1..86 400 000 (24 h). */
export const PLAY_TIME_MS_MAX = 86_400_000;

// ---------------------------------------------------------------------------------------------------------------------
// Op kinds (API §4.8 table; semantics DESIGN §3.7)
// ---------------------------------------------------------------------------------------------------------------------

/** Fields of the flat {@link SyncOp} besides the common `opId`, `kind`, `at`, `base`. */
export type SyncOpField =
  | "videoId"
  | "videoIds"
  | "after"
  | "before"
  | "liked"
  | "likedAt"
  | "type"
  | "browseId"
  | "bookmarked"
  | "bookmarkedAt"
  | "title"
  | "subtitle"
  | "thumbnailUrl"
  | "year"
  | "playlistId"
  | "name"
  | "playedAt"
  | "playTimeMs"
  | "history"
  | "playtime"
  | "mode"
  | "entries"
  | "eventsBefore"
  | "resetTotal"
  | "tracks";

export type SyncOpKindSpec = Readonly<{
  /** Required fields (API §4.8 "Обязательные поля"). A missing one → `deferred invalid_payload`. */
  required: readonly SyncOpField[];
  /** Optional fields (API §4.8 "Необязательные"). */
  optional: readonly SyncOpField[];
  /** `entityKey` template of API §4.8. */
  entityKey: string;
  /** Stream whose rows the op writes (DESIGN §3.6). */
  stream: SyncStream;
  /** Whether the op is recorded in `sync_ops` (DESIGN §3.7: all but `play.add`, which is idempotent by `play_events`). */
  journaled: boolean;
  /** Allowed length of `videoIds` (API §4.8), when the kind has that field. */
  videoIds?: Readonly<{ min: number; max: number }>;
}>;

/** API §4.8, in the order of its table (and of `features.sync.kinds` in the example of API §4.2). */
export const SYNC_OP_KIND_SPECS = Object.freeze({
  "like.set": {
    required: ["videoId", "liked"],
    optional: ["likedAt", "tracks"],
    entityKey: "like:<videoId>",
    stream: "library",
    journaled: true,
  },
  "bookmark.set": {
    required: ["type", "browseId", "bookmarked"],
    optional: ["bookmarkedAt", "title", "subtitle", "thumbnailUrl", "year"],
    entityKey: "bm:<type>:<browseId>",
    stream: "library",
    journaled: true,
  },
  "playlist.create": {
    required: ["playlistId", "name"],
    optional: ["browseId", "thumbnailUrl", "videoIds", "tracks"],
    entityKey: "pl:<playlistId>",
    stream: "library",
    journaled: true,
    videoIds: { min: 0, max: SYNC_LIMITS.maxVideoIdsPerList },
  },
  "playlist.update": {
    required: ["playlistId", "name"],
    optional: ["thumbnailUrl"],
    entityKey: "pl:<playlistId>",
    stream: "library",
    journaled: true,
  },
  "playlist.delete": {
    required: ["playlistId"],
    optional: [],
    entityKey: "pl:<playlistId>",
    stream: "library",
    journaled: true,
  },
  "playlist.items.add": {
    required: ["playlistId", "videoIds"],
    optional: ["after", "before", "tracks"],
    entityKey: "pl:<playlistId>",
    stream: "library",
    journaled: true,
    videoIds: { min: 1, max: SYNC_LIMITS.maxVideoIdsPerAdd },
  },
  "playlist.item.remove": {
    required: ["playlistId", "videoId"],
    optional: [],
    entityKey: "pl:<playlistId>",
    stream: "library",
    journaled: true,
  },
  "playlist.item.move": {
    required: ["playlistId", "videoId"],
    optional: ["after", "before"],
    entityKey: "pl:<playlistId>",
    stream: "library",
    journaled: true,
  },
  "playlist.items.replace": {
    required: ["playlistId", "videoIds"],
    optional: ["tracks"],
    entityKey: "pl:<playlistId>",
    stream: "library",
    journaled: true,
    videoIds: { min: 0, max: SYNC_LIMITS.maxVideoIdsPerList },
  },
  "playlist.import": {
    required: ["playlistId", "name", "videoIds"],
    optional: ["browseId", "thumbnailUrl", "tracks"],
    entityKey: "pl:<playlistId>",
    stream: "library",
    journaled: true,
    videoIds: { min: 0, max: SYNC_LIMITS.maxVideoIdsPerList },
  },
  "play.add": {
    required: ["videoId", "playedAt", "playTimeMs", "history", "playtime"],
    optional: ["tracks"],
    entityKey: "stat:<videoId>",
    stream: "history",
    journaled: false,
  },
  "play.baseline": {
    required: ["mode", "entries"],
    optional: ["tracks"],
    entityKey: "stat:batch",
    stream: "history",
    journaled: true,
  },
  "history.clear": {
    required: ["eventsBefore"],
    optional: [],
    entityKey: "hist:*",
    stream: "history",
    journaled: true,
  },
  "history.forget": {
    required: ["videoId", "eventsBefore", "resetTotal"],
    optional: [],
    entityKey: "stat:<videoId>",
    stream: "history",
    journaled: true,
  },
} as const satisfies Record<string, SyncOpKindSpec>);

export type SyncOpKind = keyof typeof SYNC_OP_KIND_SPECS;

/** Every op kind of API v1, in the order of API §4.8. */
export const SYNC_OP_KINDS: readonly SyncOpKind[] = Object.freeze(Object.keys(SYNC_OP_KIND_SPECS) as SyncOpKind[]);

export function isSyncOpKind(value: string): value is SyncOpKind {
  return Object.hasOwn(SYNC_OP_KIND_SPECS, value);
}

// ---------------------------------------------------------------------------------------------------------------------
// Summary and merge plan (API §4.7)
// ---------------------------------------------------------------------------------------------------------------------

export const SyncSummaryCounts = z
  .object({
    likes: IntOut,
    albums: IntOut,
    artists: IntOut,
    playlists: IntOut,
    items: IntOut,
    plays: IntOut,
    playedTracks: IntOut,
  })
  .meta({ id: "SyncSummaryCounts" });

export const SyncSummary = z
  .object({ cursor: CursorOut, serverTime: IsoOut, counts: SyncSummaryCounts })
  .meta({ id: "SyncSummary", description: "Numbers for the merge dialog (API §4.7)." });

export const MergePlanInput = z
  .object({
    localKey: text(1, MERGE_PLAN_LIMITS.localKeyMaxLength).meta({ description: "Unique within the request." }),
    syncId: optional(Uuid),
    name: text(1, STRING_LIMITS.playlistName),
    browseId: optional(z.string()),
  })
  .meta({ id: "MergePlanInput" });

export const MergePlanRequest = z
  .object({
    playlists: z
      .array(MergePlanInput)
      .max(MERGE_PLAN_LIMITS.maxPlaylists)
      .superRefine((playlists, ctx) => {
        const seen = new Set<string>();
        playlists.forEach((playlist, index) => {
          if (seen.has(playlist.localKey)) {
            ctx.addIssue({ code: "custom", path: [index, "localKey"], message: "Duplicate localKey" });
          }
          seen.add(playlist.localKey);
        });
      }),
  })
  .meta({ id: "MergePlanRequest" });

export const MergePlanEntry = z
  .object({
    localKey: z.string(),
    action: enumOut(MERGE_ACTION_VALUES),
    playlistId: UuidOut,
    serverName: z.string().nullable(),
  })
  .meta({ id: "MergePlanEntry" });

export const MergePlanResponse = z
  .object({ plan: z.array(MergePlanEntry).meta({ description: "In the order of the request." }) })
  .meta({ id: "MergePlanResponse" });

// ---------------------------------------------------------------------------------------------------------------------
// POST /sync request (API §4.8)
// ---------------------------------------------------------------------------------------------------------------------

export const BookmarkKey = z
  .object({ type: z.enum(BOOKMARK_TYPE_VALUES), browseId: BrowseId })
  .meta({ id: "BookmarkKey" });

export const SyncInclude = z
  .object({
    likes: optional(z.array(VideoId)),
    playlists: optional(z.array(Uuid)),
    bookmarks: optional(z.array(BookmarkKey)),
    playStats: optional(z.array(VideoId)),
  })
  .superRefine((include, ctx) => {
    const total =
      (include.likes?.length ?? 0) +
      (include.playlists?.length ?? 0) +
      (include.bookmarks?.length ?? 0) +
      (include.playStats?.length ?? 0);
    if (total > SYNC_LIMITS.maxIncludeKeys) {
      ctx.addIssue({
        code: "too_big",
        origin: "array",
        maximum: SYNC_LIMITS.maxIncludeKeys,
        inclusive: true,
        input: include,
        message: `include has more than ${SYNC_LIMITS.maxIncludeKeys} keys in total`,
      });
    }
  })
  .meta({ id: "SyncInclude", description: "Return the current rows of these keys (at most 1000 in total)." });

export const BaselineEntry = z
  .object({
    videoId: z.string().meta({ pattern: VIDEO_ID_PATTERN.source }),
    totalMs: int(1),
  })
  .meta({ id: "BaselineEntry" });

const opVideoId = z.string().meta({
  pattern: VIDEO_ID_PATTERN.source,
  description: "VideoId; an invalid one → `rejected invalid_video_id`.",
});

/**
 * API §4.8 `SyncOp`: one flat schema with `kind` (API §1.3: no polymorphism). Documentation only, see the module
 * comment; the fields each kind needs are in {@link SYNC_OP_KIND_SPECS}.
 */
export const SyncOp = z
  .object({
    opId: Uuid.meta({ description: "UUID v4 made by the client; `play.add`: the eventId." }),
    kind: text(1, OP_KIND_MAX_LENGTH).meta({
      description: `One of features.sync.kinds: ${Object.keys(SYNC_OP_KIND_SPECS).join(", ")}. An unknown kind → deferred unknown_kind.`,
    }),
    at: Iso.meta({ description: "When the user acted (client clock with clockOffset); `play.add`: = playedAt." }),
    base: optional(text(0, OP_BASE_MAX_LENGTH)).meta({
      description: "The client's cursor when the user acted; used to resolve conflicts (DESIGN §3.4).",
    }),
    videoId: optional(opVideoId),
    videoIds: optional(z.array(opVideoId)),
    after: optional(opVideoId.meta({ description: "Anchor: insert right after this videoId." })),
    before: optional(opVideoId.meta({ description: "Anchor: insert right before this videoId." })),
    liked: optional(z.boolean()),
    likedAt: optional(Iso),
    type: optional(z.string().meta({ description: "Bookmark type: album | artist." })),
    browseId: optional(z.string().meta({ maxLength: STRING_LIMITS.browseId })),
    bookmarked: optional(z.boolean()),
    bookmarkedAt: optional(Iso),
    title: optional(z.string().meta({ maxLength: STRING_LIMITS.title })),
    subtitle: optional(z.string().meta({ maxLength: STRING_LIMITS.title })),
    thumbnailUrl: optional(z.string().meta({ maxLength: STRING_LIMITS.url })),
    year: optional(z.string().meta({ maxLength: STRING_LIMITS.year })),
    playlistId: optional(z.string().meta({ description: "Uuid of the playlist." })),
    name: optional(
      z.string().meta({ description: "Playlist name: trimmed, cut to 200; empty → «Без названия» / «Untitled»." }),
    ),
    playedAt: optional(Iso),
    playTimeMs: optional(intRange(1, PLAY_TIME_MS_MAX)),
    history: optional(z.boolean()),
    playtime: optional(z.boolean()),
    mode: optional(z.string().meta({ description: "play.baseline: add | atLeast." })),
    entries: optional(z.array(BaselineEntry).meta({ minItems: 1, maxItems: SYNC_LIMITS.maxBaselineEntries })),
    eventsBefore: optional(Iso.meta({ description: "Inclusive watermark." })),
    resetTotal: optional(z.boolean()),
    tracks: optional(z.array(TrackInput).meta({ description: "Metadata of the videoIds the op mentions." })),
  })
  .meta({
    id: "SyncOp",
    description:
      "Flat op (API §4.8). The route checks only opId, kind, at, base and unique opIds; other fields are checked per kind and answer in OpResult.",
  });

const streams = z
  .array(z.enum(SYNC_STREAM_VALUES))
  .min(1)
  .superRefine((values, ctx) => {
    if (new Set(values).size !== values.length) {
      ctx.addIssue({ code: "custom", message: "Duplicate stream" });
    }
  })
  .meta({ uniqueItems: true, description: "Non-empty subset; default: both." });

function uniqueOpIds(ops: readonly { opId: string }[], ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  ops.forEach((op, index) => {
    if (seen.has(op.opId)) ctx.addIssue({ code: "custom", path: [index, "opId"], message: "Duplicate opId" });
    seen.add(op.opId);
  });
}

const limit = int(1, SYNC_LIMITS.maxPageSize).meta({
  description: "Rows per page, default 500 (the first sync: 2000).",
});

export const SyncRequest = z
  .object({
    cursor: Cursor,
    limit: optional(limit),
    streams: optional(streams),
    ops: optional(z.array(SyncOp).max(SYNC_LIMITS.maxOpsPerRequest).superRefine(uniqueOpIds)),
    include: optional(SyncInclude),
  })
  .meta({ id: "SyncRequest" });

/** An op as the route validates it: the common fields, everything else kept for the handler (DESIGN §3.9). */
export const SyncOpEnvelope = z.looseObject({
  opId: Uuid,
  kind: text(1, OP_KIND_MAX_LENGTH),
  at: Iso,
  base: optional(text(0, OP_BASE_MAX_LENGTH)),
});

/** What the `/sync` route validates (its own validator; {@link SyncRequest} stays the OpenAPI body). */
export const SyncRequestEnvelope = z.object({
  cursor: Cursor,
  limit: optional(limit),
  streams: optional(streams),
  ops: optional(z.array(SyncOpEnvelope).max(SYNC_LIMITS.maxOpsPerRequest).superRefine(uniqueOpIds)),
  include: optional(SyncInclude),
});

// ---------------------------------------------------------------------------------------------------------------------
// POST /sync response (API §4.8)
// ---------------------------------------------------------------------------------------------------------------------

export const OpResult = z
  .object({
    opId: UuidOut,
    status: enumOut(OP_STATUS_VALUES),
    code: enumOut(Object.keys(OP_RESULT_CODES), "API §2.3.").nullable(),
    seq: IntOut.nullable().meta({ description: "For debugging." }),
    playlistId: UuidOut.nullable().meta({ description: "Only `redirected`: the recovery playlist." }),
    retryAfterSeconds: IntOut.nullable().meta({ description: "Only `op_rate_limited`." }),
    replayed: z.boolean(),
  })
  .meta({ id: "OpResult" });

export const PlaylistRow = z
  .object({
    id: UuidOut,
    name: textOut(STRING_LIMITS.playlistName, 1),
    browseId: BrowseIdOut.nullable(),
    thumbnailUrl: HttpUrlOut.nullable(),
    createdAt: IsoOut,
    deleted: z.boolean(),
  })
  .meta({ id: "PlaylistRow" });

export const PlaylistItemRow = z
  .object({
    playlistId: UuidOut,
    videoId: VideoIdOut,
    present: z.boolean().meta({ description: "`false`: a tombstone." }),
    sortKey: z.string().meta({ description: "Fractional index, base62, compared ordinally (API §8)." }),
    addedAt: IsoOut,
  })
  .meta({ id: "PlaylistItemRow" });

export const LikeRow = z
  .object({ videoId: VideoIdOut, liked: z.boolean(), likedAt: IsoOut.nullable() })
  .meta({ id: "LikeRow" });

export const BookmarkRow = z
  .object({
    type: enumOut(BOOKMARK_TYPE_VALUES),
    browseId: BrowseIdOut,
    bookmarked: z.boolean(),
    bookmarkedAt: IsoOut.nullable(),
    title: textOut(STRING_LIMITS.title).nullable(),
    subtitle: textOut(STRING_LIMITS.title).nullable(),
    thumbnailUrl: HttpUrlOut.nullable(),
    year: textOut(STRING_LIMITS.year).nullable(),
  })
  .meta({ id: "BookmarkRow" });

export const PlayRow = z
  .object({
    eventId: UuidOut,
    videoId: VideoIdOut,
    playedAt: IsoOut,
    playTimeMs: IntOut,
    deviceId: UuidOut.nullable(),
  })
  .meta({ id: "PlayRow" });

export const PlayStatRow = z
  .object({ videoId: VideoIdOut, totalPlayTimeMs: IntOut, lastPlayedAt: IsoOut.nullable() })
  .meta({ id: "PlayStatRow" });

export const PlayForgetRow = z
  .object({
    videoId: z.string().meta({ description: 'VideoId, or "*" for the whole history.' }),
    eventsBefore: IsoOut.meta({ description: "Inclusive." }),
    totalBefore: IsoOut.nullable(),
  })
  .meta({ id: "PlayForgetRow" });

export const SyncResponse = z
  .object({
    results: z.array(OpResult).meta({ description: "In the order of ops." }),
    cursor: CursorOut,
    hasMore: z.boolean(),
    serverTime: IsoOut,
    tracks: z.array(TrackDto).meta({ description: "Ordered by videoId." }),
    playlists: z.array(PlaylistRow),
    items: z.array(PlaylistItemRow),
    likes: z.array(LikeRow),
    bookmarks: z.array(BookmarkRow),
    plays: z.array(PlayRow),
    playStats: z.array(PlayStatRow),
    playForgets: z.array(PlayForgetRow),
  })
  .meta({
    id: "SyncResponse",
    description:
      "Every row key appears once, as its full current image. Apply: tracks → playlists (by createdAt) → items → likes → bookmarks → playStats → plays → playForgets.",
  });

export type SyncSummary = z.output<typeof SyncSummary>;
export type MergePlanInput = z.output<typeof MergePlanInput>;
export type MergePlanRequest = z.output<typeof MergePlanRequest>;
export type MergePlanEntry = z.output<typeof MergePlanEntry>;
export type MergePlanResponse = z.output<typeof MergePlanResponse>;
export type BookmarkKey = z.output<typeof BookmarkKey>;
export type SyncInclude = z.output<typeof SyncInclude>;
export type BaselineEntry = z.output<typeof BaselineEntry>;
export type SyncOp = z.output<typeof SyncOp>;
export type SyncRequest = z.output<typeof SyncRequest>;
export type SyncOpEnvelope = z.output<typeof SyncOpEnvelope>;
export type SyncRequestEnvelope = z.output<typeof SyncRequestEnvelope>;
export type OpResult = z.output<typeof OpResult>;
export type PlaylistRow = z.output<typeof PlaylistRow>;
export type PlaylistItemRow = z.output<typeof PlaylistItemRow>;
export type LikeRow = z.output<typeof LikeRow>;
export type BookmarkRow = z.output<typeof BookmarkRow>;
export type PlayRow = z.output<typeof PlayRow>;
export type PlayStatRow = z.output<typeof PlayStatRow>;
export type PlayForgetRow = z.output<typeof PlayForgetRow>;
export type SyncResponse = z.output<typeof SyncResponse>;
