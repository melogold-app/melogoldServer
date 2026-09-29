/**
 * API §4.11: snapshots of own playlists by link (`/shares`, the public `GET /shares/{shareId}` and the page
 * `GET /s/{shareId}`). A snapshot never changes; tracks are cleaned like everywhere else (DESIGN §3.9).
 */
import { z } from "zod";
import { enumOut, IsoOut, matching, text, textOut, TrackDto, TrackInput } from "./common.ts";
import { SHARE_ID_PATTERN, SHARE_LIMITS, STRING_LIMITS } from "./limits.ts";

/** `CreateShareRequest.kind`. */
export const SHARE_KIND_VALUES = ["playlist"] as const;
export type ShareKind = (typeof SHARE_KIND_VALUES)[number];

export const ShareId = matching(SHARE_ID_PATTERN).meta({ description: "10 base62 characters (API §4.11)." });
export const ShareIdOut = z.string().meta({ pattern: SHARE_ID_PATTERN.source, description: "ShareId." });
export const ShareIdParams = z.object({ shareId: ShareId });

export const CreateShareRequest = z
  .object({
    kind: z.enum(SHARE_KIND_VALUES),
    name: text(1, STRING_LIMITS.playlistName).meta({
      description: "Trimmed; blank → «Без названия» / «Untitled» by Accept-Language.",
    }),
    tracks: z.array(TrackInput).min(1).max(SHARE_LIMITS.maxTracks),
  })
  .meta({ id: "CreateShareRequest" });

export const ShareCreated = z
  .object({
    shareId: ShareIdOut,
    url: z.string().meta({ description: "<PUBLIC_URL or the request's origin>/s/<shareId>." }),
    createdAt: IsoOut,
  })
  .meta({ id: "ShareCreated" });

export const ShareDto = z
  .object({
    shareId: ShareIdOut,
    kind: enumOut(SHARE_KIND_VALUES),
    name: textOut(STRING_LIMITS.playlistName, 1),
    url: z.string(),
    tracks: z.array(TrackDto),
    createdAt: IsoOut,
  })
  .meta({ id: "ShareDto" });

export const ShareList = z
  .object({ shares: z.array(ShareDto).meta({ description: "Newest first." }) })
  .meta({ id: "ShareList" });

export type ShareIdParams = z.output<typeof ShareIdParams>;
export type CreateShareRequest = z.output<typeof CreateShareRequest>;
export type ShareCreated = z.output<typeof ShareCreated>;
export type ShareDto = z.output<typeof ShareDto>;
export type ShareList = z.output<typeof ShareList>;
