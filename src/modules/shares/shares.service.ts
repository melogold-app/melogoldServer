/**
 * Snapshots of own playlists by link (API §4.11, `features.share`). A snapshot never changes: a changed playlist is
 * shared again under a new link. Tracks are cleaned like a playback queue (DESIGN §3.9); the name is trimmed, a blank
 * one becomes «Без названия» / «Untitled».
 */
import { randomInt } from "node:crypto";
import type { AppContext } from "../../context.ts";
import { SHARE_LIMITS, STRING_LIMITS } from "../../contract/limits.ts";
import type { CreateShareRequest, ShareCreated, ShareDto, ShareList } from "../../contract/shares.ts";
import { AppError } from "../../http/errors.ts";
import { truncateUtf16 } from "../../lib/strings.ts";
import { formatIso } from "../../lib/time.ts";
import { cleanTrackInput } from "../playback/playback.tracks.ts";
import type { LandingLocale } from "../server/landing.ts";
import { countShares, deleteShare, findShare, insertShare, listShares } from "./shares.repository.ts";
import type { StoredShare } from "./shares.repository.ts";

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ID_LENGTH = 10;
/** 62^10 ids: a collision is astronomically rare; a few retries cover it. */
const ID_ATTEMPTS = 5;

export const UNTITLED: Readonly<Record<LandingLocale, string>> = Object.freeze({ ru: "Без названия", en: "Untitled" });

export function newShareId(): string {
  let id = "";
  for (let index = 0; index < ID_LENGTH; index++) id += ALPHABET.charAt(randomInt(ALPHABET.length));
  return id;
}

/** `<base>/s/<id>`; `base` is `PUBLIC_URL` or the request's origin (API §4.11). */
export function shareUrl(base: string | null, id: string): string {
  return `${base ?? ""}/s/${id}`;
}

function shareName(name: string, locale: LandingLocale): string {
  const trimmed = truncateUtf16(name.trim(), STRING_LIMITS.playlistName).trimEnd();
  return trimmed === "" ? UNTITLED[locale] : trimmed;
}

export function toShareDto(share: StoredShare, base: string | null): ShareDto {
  return {
    shareId: share.id,
    kind: share.kind,
    name: share.name,
    url: shareUrl(base, share.id),
    tracks: [...share.tracks],
    createdAt: formatIso(share.createdAt),
  };
}

/** `POST /shares` (API §4.11). */
export async function createShare(
  ctx: AppContext,
  userId: string,
  request: CreateShareRequest,
  base: string | null,
  locale: LandingLocale,
): Promise<ShareCreated> {
  const tracks = request.tracks.map((item) => cleanTrackInput(item));
  const name = shareName(request.name, locale);
  const createdAt = ctx.clock.now();
  const id = await ctx.db.write(async (q) => {
    if ((await countShares(q, userId)) >= SHARE_LIMITS.maxShares) {
      throw new AppError("share_limit_reached", { details: { maxShares: SHARE_LIMITS.maxShares } });
    }
    for (let attempt = 0; attempt < ID_ATTEMPTS; attempt++) {
      const candidate = newShareId();
      if (await insertShare(q, { id: candidate, userId, kind: request.kind, name, tracks, createdAt }))
        return candidate;
    }
    throw new Error("could not find a free share id");
  });
  return { shareId: id, url: shareUrl(base, id), createdAt: formatIso(createdAt) };
}

/** `GET /shares` (API §4.11): newest first. */
export async function listMyShares(ctx: AppContext, userId: string, base: string | null): Promise<ShareList> {
  const shares = await ctx.db.read((q) => listShares(q, userId));
  return { shares: shares.map((share) => toShareDto(share, base)) };
}

/** `GET /shares/{shareId}` and the page (API §4.11): public; the owner is not disclosed. */
export async function getShare(ctx: AppContext, id: string): Promise<StoredShare | null> {
  return ctx.db.read((q) => findShare(q, id));
}

/** `DELETE /shares/{shareId}` (API §4.11): the user's own only. */
export async function deleteMyShare(ctx: AppContext, userId: string, id: string): Promise<void> {
  const deleted = await ctx.db.write((q) => deleteShare(q, userId, id));
  if (!deleted) throw new AppError("share_not_found");
}
