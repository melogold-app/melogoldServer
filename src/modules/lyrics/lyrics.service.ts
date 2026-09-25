/**
 * API §4.10: the user's lyrics and the shared ones. Writes take `lockUser` first (the user's `rev` is max + 1) and
 * publish `lyrics.changed` to the user's other devices only after commit and only when something changed
 * (docs/database.md §2.4).
 */
import { LYRICS_LIMITS } from "../../contract/lyrics.ts";
import type {
  LyricsChangesRequest,
  LyricsPut,
  LyricsResponse,
  LyricsText,
  MyLyrics,
  MyLyricsPage,
  SharedLyrics,
} from "../../contract/lyrics.ts";
import type { AppContext } from "../../context.ts";
import { lockUser } from "../../db/heads.ts";
import type { RequestAuth } from "../../http/auth-guard.ts";
import { newId } from "../../lib/ids.ts";
import { formatIso } from "../../lib/time.ts";
import * as repo from "./lyrics.repository.ts";
import type { LyricsContent, StoredLyrics } from "./lyrics.repository.ts";

const EMPTY: LyricsContent = Object.freeze({
  plain: null,
  plainSource: null,
  synced: null,
  syncedFormat: null,
  syncedSource: null,
  startTimeMs: null,
  language: null,
});

/** What `PUT` stores: a source without the text of its side is dropped (API §4.10). */
export function contentOf(put: LyricsPut): LyricsContent {
  const plain = put.plain ?? null;
  const synced = put.synced ?? null;
  return Object.freeze({
    plain,
    plainSource: plain === null ? null : (put.plainSource ?? null),
    synced,
    syncedFormat: synced === null ? null : (put.syncedFormat ?? null),
    syncedSource: synced === null ? null : (put.syncedSource ?? null),
    startTimeMs: put.startTimeMs ?? null,
    language: put.language ?? null,
  });
}

export function sameContent(a: LyricsContent, b: LyricsContent): boolean {
  return (
    a.plain === b.plain &&
    a.plainSource === b.plainSource &&
    a.synced === b.synced &&
    a.syncedFormat === b.syncedFormat &&
    a.syncedSource === b.syncedSource &&
    a.startTimeMs === b.startTimeMs &&
    a.language === b.language
  );
}

function toText(content: LyricsContent): LyricsText {
  return { ...content };
}

function toMyLyrics(lyrics: StoredLyrics): MyLyrics {
  return {
    id: lyrics.id,
    videoId: lyrics.videoId,
    rev: lyrics.rev,
    deleted: lyrics.deleted,
    text: lyrics.deleted ? null : toText(lyrics.content),
    updatedAt: formatIso(lyrics.updatedAt),
  };
}

function toShared(lyrics: StoredLyrics): SharedLyrics {
  return {
    id: lyrics.id,
    videoId: lyrics.videoId,
    text: toText(lyrics.content),
    updatedAt: formatIso(lyrics.updatedAt),
  };
}

/** `GET /lyrics/{videoId}`: the caller's version (no tombstones) and the shared one. */
export async function getLyrics(ctx: AppContext, userId: string, videoId: string): Promise<LyricsResponse> {
  const { mine, shared } = await ctx.db.read(async (q) => ({
    mine: await repo.findUserLyrics(q, userId, videoId),
    shared: await repo.findSharedLyrics(q, videoId, userId),
  }));
  return {
    mine: mine === null || mine.deleted ? null : toMyLyrics(mine),
    shared: shared === null ? null : toShared(shared),
    serverTime: formatIso(ctx.clock.now()),
  };
}

type WriteOutcome = Readonly<{ lyrics: StoredLyrics | null; changed: boolean }>;

/** Writes `next` content (or a tombstone when `null`) unless it is what the user already has. */
async function writeLyrics(
  ctx: AppContext,
  auth: RequestAuth,
  videoId: string,
  next: LyricsContent | null,
): Promise<WriteOutcome> {
  const now = ctx.clock.now();
  const outcome = await ctx.db.write(async (q): Promise<WriteOutcome> => {
    await lockUser(q, auth.userId);
    const current = await repo.findUserLyrics(q, auth.userId, videoId);
    if (next === null) {
      if (current === null || current.deleted) return { lyrics: current, changed: false };
    } else if (current !== null && !current.deleted && sameContent(current.content, next)) {
      return { lyrics: current, changed: false };
    }
    const lyrics: StoredLyrics = Object.freeze({
      id: current?.id ?? newId(),
      userId: auth.userId,
      videoId,
      rev: (await repo.maxUserRev(q, auth.userId)) + 1,
      deleted: next === null,
      content: next ?? EMPTY,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    });
    await repo.upsertUserLyrics(q, lyrics);
    return { lyrics, changed: true };
  });
  if (outcome.changed && outcome.lyrics !== null) {
    ctx.live.publishCoalesced(
      auth.userId,
      "lyrics.changed",
      { videoId, rev: outcome.lyrics.rev },
      { excludeDeviceId: auth.deviceId },
    );
  }
  return outcome;
}

/** `PUT /lyrics/{videoId}`: creates or replaces the caller's version. */
export async function putLyrics(
  ctx: AppContext,
  auth: RequestAuth,
  videoId: string,
  put: LyricsPut,
): Promise<MyLyrics> {
  const { lyrics } = await writeLyrics(ctx, auth, videoId, contentOf(put));
  if (lyrics === null) throw new Error("PUT /lyrics wrote nothing");
  return toMyLyrics(lyrics);
}

/** `DELETE /lyrics/{videoId}`: a tombstone; nothing when there is no live version. */
export async function deleteLyrics(ctx: AppContext, auth: RequestAuth, videoId: string): Promise<void> {
  await writeLyrics(ctx, auth, videoId, null);
}

/** `POST /auth/me/lyrics/changes`: the caller's versions after `after` (API §4.10). */
export async function listMyLyricsChanges(
  ctx: AppContext,
  userId: string,
  request: LyricsChangesRequest,
): Promise<MyLyricsPage> {
  const limit = request.limit ?? LYRICS_LIMITS.defaultPageSize;
  const firstLoad = request.after === 0;
  const { rows, maxRev } = await ctx.db.read(async (q) => ({
    rows: await repo.listUserChanges(q, userId, request.after, limit + 1, !firstLoad),
    maxRev: firstLoad ? await repo.maxUserRev(q, userId) : 0,
  }));
  const more = rows.length > limit;
  const items = rows.slice(0, limit);
  // The first load skips tombstones: without more pages, the next request starts after all of them
  const last = items.at(-1)?.rev ?? request.after;
  return { items: items.map(toMyLyrics), rev: firstLoad && !more ? Math.max(last, maxRev) : last, more };
}
