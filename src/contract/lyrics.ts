/**
 * API §4.10: lyrics of a track made or chosen by the user (`GET/PUT/DELETE /lyrics/{videoId}`,
 * `POST /auth/me/lyrics/changes`).
 *
 * The server keeps the texts opaque: it checks lengths and the `plain`/`synced` rules, never parses LRC or TTML.
 */
import { z } from "zod";
import { enumOut, int, IntOut, IsoOut, optional, text, textOut, UuidOut, VideoId, VideoIdOut } from "./common.ts";

/** Where one side of the lyrics came from (`plainSource`, `syncedSource`). */
export const LYRICS_SOURCE_VALUES = ["user", "file", "youtube_music", "lrclib", "kugou"] as const;
export type LyricsSource = (typeof LYRICS_SOURCE_VALUES)[number];

/** The format of `synced`. */
export const LYRICS_FORMAT_VALUES = ["lrc", "ttml"] as const;
export type LyricsFormat = (typeof LYRICS_FORMAT_VALUES)[number];

/** API §4.10 "Лимиты" (UTF-16 units). */
export const LYRICS_LIMITS = Object.freeze({
  plainMax: 50_000,
  syncedMax: 200_000,
  languageMax: 35,
  startTimeMaxMs: 86_400_000,
  defaultPageSize: 100,
  maxPageSize: 200,
} as const);

export const VideoIdParams = z.object({ videoId: VideoId });

export const LyricsText = z
  .object({
    plain: textOut(LYRICS_LIMITS.plainMax).nullable(),
    plainSource: enumOut(LYRICS_SOURCE_VALUES).nullable(),
    synced: textOut(LYRICS_LIMITS.syncedMax).nullable(),
    syncedFormat: enumOut(LYRICS_FORMAT_VALUES, "Present together with `synced`.").nullable(),
    syncedSource: enumOut(LYRICS_SOURCE_VALUES).nullable(),
    startTimeMs: IntOut.nullable().meta({ description: "Where the synced lyrics start in the track." }),
    language: textOut(LYRICS_LIMITS.languageMax).nullable().meta({ description: "BCP 47." }),
  })
  .meta({ id: "LyricsText" });

export const LyricsPut = z
  .object({
    plain: optional(text(1, LYRICS_LIMITS.plainMax)),
    plainSource: optional(z.enum(LYRICS_SOURCE_VALUES)),
    synced: optional(text(1, LYRICS_LIMITS.syncedMax)),
    syncedFormat: optional(z.enum(LYRICS_FORMAT_VALUES)),
    syncedSource: optional(z.enum(LYRICS_SOURCE_VALUES)),
    startTimeMs: optional(int(0, LYRICS_LIMITS.startTimeMaxMs)),
    language: optional(text(1, LYRICS_LIMITS.languageMax)),
  })
  .superRefine((put, ctx) => {
    if (put.plain === undefined && put.synced === undefined) {
      ctx.addIssue({ code: "custom", path: ["plain"], message: "plain or synced is required" });
    }
    if (put.synced !== undefined && put.syncedFormat === undefined) {
      ctx.addIssue({ code: "custom", path: ["syncedFormat"], message: "syncedFormat is required with synced" });
    }
    if (put.synced === undefined && put.syncedFormat !== undefined) {
      ctx.addIssue({ code: "custom", path: ["syncedFormat"], message: "syncedFormat needs synced" });
    }
  })
  .meta({ id: "LyricsPut" });

export const MyLyrics = z
  .object({
    id: UuidOut,
    videoId: VideoIdOut,
    rev: IntOut.meta({ description: "The user's change counter: grows with every PUT and DELETE." }),
    deleted: z.boolean().meta({ description: "Tombstone of DELETE; `text` is null then." }),
    text: LyricsText.nullable(),
    updatedAt: IsoOut,
  })
  .meta({ id: "MyLyrics" });

export const SharedLyrics = z
  .object({ id: UuidOut, videoId: VideoIdOut, text: LyricsText, updatedAt: IsoOut })
  .meta({ id: "SharedLyrics", description: "Another user's version; the author is not disclosed." });

export const LyricsResponse = z
  .object({ mine: MyLyrics.nullable(), shared: SharedLyrics.nullable(), serverTime: IsoOut })
  .meta({ id: "LyricsResponse" });

export const LyricsChangesRequest = z
  .object({
    after: int(0),
    limit: optional(int(1, LYRICS_LIMITS.maxPageSize)).meta({ description: "Default 100." }),
  })
  .meta({ id: "LyricsChangesRequest" });

export const MyLyricsPage = z
  .object({
    items: z.array(MyLyrics).meta({ description: "`rev > after`, ascending." }),
    rev: IntOut.meta({ description: "`after` of the next request." }),
    more: z.boolean(),
  })
  .meta({ id: "MyLyricsPage" });

export type VideoIdParams = z.output<typeof VideoIdParams>;
export type LyricsText = z.output<typeof LyricsText>;
export type LyricsPut = z.output<typeof LyricsPut>;
export type MyLyrics = z.output<typeof MyLyrics>;
export type SharedLyrics = z.output<typeof SharedLyrics>;
export type LyricsResponse = z.output<typeof LyricsResponse>;
export type LyricsChangesRequest = z.output<typeof LyricsChangesRequest>;
export type MyLyricsPage = z.output<typeof MyLyricsPage>;
