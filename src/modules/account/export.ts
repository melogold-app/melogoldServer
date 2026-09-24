/**
 * `GET /auth/me/export` (API §4.5, DESIGN §4.11): the account as one `ExportDocument`, **streamed**.
 *
 * - The small head (account, devices, playback state) is read first in one `db.read`, so a problem there still answers
 *   a normal JSON error. Then the document is written piece by piece: every array is read in **keyset pages** of
 *   {@link EXPORT_PAGE_SIZE} rows, each page in its own short `db.read` (docs/database.md §2.3: SQLite has one
 *   connection, long reads would hold everyone). So the document is **not an atomic snapshot**, as the API says.
 * - Only what the user owns and sees: liked videos, bookmarked albums and artists, live playlists with their present
 *   items (`ORDER BY sort_key, video_id`), plays in the history, totals and watermarks. **No secrets:** no password or
 *   recovery code hashes, no tokens, no hwid (not even its hash).
 * - Keys come in the order of the contract (`ExportDocument` and its components), so a client can stream-parse it.
 * - If a page fails after the first bytes went out, the stream is destroyed: the client sees a truncated download and
 *   not a document that looks complete.
 */
import { EXPORT_FORMAT, EXPORT_FORMAT_VERSION } from "../../contract/account.ts";
import type { ExportPlaylist } from "../../contract/account.ts";
import type { AppContext } from "../../context.ts";
import type { RequestAuth } from "../../http/auth-guard.ts";
import { AppError } from "../../http/errors.ts";
import { formatIso } from "../../lib/time.ts";
import * as repo from "./account.repository.ts";
import type { PlaylistRow } from "./account.repository.ts";
import {
  toBookmarkDto,
  toDeviceDto,
  toLikeDto,
  toPlayDto,
  toPlayForgetDto,
  toPlayStatDto,
  toPlaybackState,
  toTrackDto,
} from "./dto.ts";

/** Rows per keyset page (one short read transaction each). */
export const EXPORT_PAGE_SIZE = 1000;

export type ExportOptions = Readonly<{ pageSize?: number }>;

export type PreparedExport = Readonly<{
  /** `melogold-export-<login>-<YYYY-MM-DD>.json` (API §4.5). */
  filename: string;
  /** The JSON text of the `ExportDocument`, in pieces. */
  chunks: AsyncIterable<string>;
}>;

/** `Content-Disposition` of the export: the login is limited to filename-safe characters. */
export function exportFilename(login: string, exportedAt: number): string {
  const safe = login.replace(/[^a-z0-9._-]/gi, "_");
  return `melogold-export-${safe}-${formatIso(exportedAt).slice(0, 10)}.json`;
}

export function contentDisposition(filename: string): string {
  return `attachment; filename="${filename}"`;
}

/** The members of an array, page by page: `fetch(after, limit)` gives rows after the key of the previous page. */
async function* arrayMembers<R, K>(
  fetch: (after: K | null, limit: number) => Promise<readonly R[]>,
  keyOf: (row: R) => K,
  write: (row: R) => string | AsyncIterable<string>,
  pageSize: number,
): AsyncGenerator<string> {
  let after: K | null = null;
  let first = true;
  for (;;) {
    const rows = await fetch(after, pageSize);
    let piece = "";
    for (const row of rows) {
      const written = write(row);
      if (typeof written === "string") {
        piece += (first ? "" : ",") + written;
        first = false;
        continue;
      }
      if (piece !== "") yield piece;
      piece = "";
      if (!first) yield ",";
      first = false;
      yield* written;
    }
    if (piece !== "") yield piece;
    const last = rows.at(-1);
    if (rows.length < pageSize || last === undefined) return;
    after = keyOf(last);
  }
}

/**
 * Reads the head of the document and returns the stream of the rest.
 * @throws AppError `session_revoked` when the account is gone (deleted since the guard ran).
 */
export async function prepareExport(
  ctx: AppContext,
  auth: RequestAuth,
  options: ExportOptions = {},
): Promise<PreparedExport> {
  const pageSize = options.pageSize ?? EXPORT_PAGE_SIZE;
  const { userId } = auth;
  const exportedAt = ctx.clock.now();
  const head = await ctx.db.read(async (q) => {
    const user = await repo.findActiveUser(q, userId);
    if (!user) return null;
    const devices = await repo.listDevices(q, userId);
    const playback = await repo.findPlaybackState(q, userId);
    return { user, devices, playback };
  });
  if (head === null) throw new AppError("session_revoked");

  const devices = head.devices.map((device) =>
    toDeviceDto(device, {
      currentDeviceId: auth.deviceId,
      now: exportedAt,
      newDeviceRestrictHours: ctx.env.NEW_DEVICE_RESTRICT_HOURS,
    }),
  );
  const opening =
    `{"format":${JSON.stringify(EXPORT_FORMAT)},"formatVersion":${EXPORT_FORMAT_VERSION}` +
    `,"exportedAt":${JSON.stringify(formatIso(exportedAt))}` +
    `,"server":${JSON.stringify({ serverId: ctx.serverId, instanceName: ctx.env.INSTANCE_NAME, version: ctx.env.APP_VERSION })}` +
    `,"account":${JSON.stringify({
      id: head.user.id,
      login: head.user.login,
      createdAt: formatIso(head.user.created_at),
      passwordChangedAt: formatIso(head.user.password_changed_at),
    })}` +
    `,"devices":${JSON.stringify(devices)}`;
  const playback = JSON.stringify(toPlaybackState(head.playback));

  async function* playlistItems(playlistId: string): AsyncGenerator<string> {
    yield* arrayMembers(
      (after: { sortKey: string; videoId: string } | null, limit) =>
        ctx.db.read((q) => repo.exportPlaylistItemsPage(q, userId, playlistId, after, limit)),
      (row) => ({ sortKey: row.sort_key, videoId: row.video_id }),
      (row) => JSON.stringify({ videoId: row.video_id, addedAt: formatIso(row.added_at) }),
      pageSize,
    );
  }

  async function* playlist(row: PlaylistRow): AsyncGenerator<string> {
    const header: Omit<ExportPlaylist, "items"> = {
      id: row.id,
      name: row.name,
      browseId: row.browse_id,
      thumbnailUrl: row.thumbnail_url,
      createdAt: formatIso(row.created_at),
    };
    yield `${JSON.stringify(header).slice(0, -1)},"items":[`;
    yield* playlistItems(row.id);
    yield "]}";
  }

  async function* document(): AsyncGenerator<string> {
    yield `${opening},"library":{"tracks":[`;
    yield* arrayMembers(
      (after: string | null, limit) => ctx.db.read((q) => repo.exportTracksPage(q, userId, after, limit)),
      (row) => row.video_id,
      (row) => JSON.stringify(toTrackDto(row)),
      pageSize,
    );
    yield `],"likes":[`;
    yield* arrayMembers(
      (after: string | null, limit) => ctx.db.read((q) => repo.exportLikesPage(q, userId, after, limit)),
      (row) => row.video_id,
      (row) => JSON.stringify(toLikeDto(row)),
      pageSize,
    );
    yield `],"bookmarks":[`;
    yield* arrayMembers(
      (after: { type: string; browseId: string } | null, limit) =>
        ctx.db.read((q) => repo.exportBookmarksPage(q, userId, after, limit)),
      (row) => ({ type: row.type, browseId: row.browse_id }),
      (row) => JSON.stringify(toBookmarkDto(row)),
      pageSize,
    );
    yield `],"playlists":[`;
    yield* arrayMembers(
      (after: { createdAt: number; id: string } | null, limit) =>
        ctx.db.read((q) => repo.exportPlaylistsPage(q, userId, after, limit)),
      (row) => ({ createdAt: row.created_at, id: row.id }),
      (row) => playlist(row),
      pageSize,
    );
    yield `]},"history":{"plays":[`;
    yield* arrayMembers(
      (after: { playedAt: number; eventId: string } | null, limit) =>
        ctx.db.read((q) => repo.exportPlaysPage(q, userId, after, limit)),
      (row) => ({ playedAt: row.played_at, eventId: row.event_id }),
      (row) => JSON.stringify(toPlayDto(row)),
      pageSize,
    );
    yield `],"playStats":[`;
    yield* arrayMembers(
      (after: string | null, limit) => ctx.db.read((q) => repo.exportPlayStatsPage(q, userId, after, limit)),
      (row) => row.video_id,
      (row) => JSON.stringify(toPlayStatDto(row)),
      pageSize,
    );
    yield `],"playForgets":[`;
    yield* arrayMembers(
      (after: string | null, limit) => ctx.db.read((q) => repo.exportPlayForgetsPage(q, userId, after, limit)),
      (row) => row.video_id,
      (row) => JSON.stringify(toPlayForgetDto(row)),
      pageSize,
    );
    yield `]},"playback":${playback}}`;
  }

  return Object.freeze({ filename: exportFilename(head.user.login, exportedAt), chunks: document() });
}
