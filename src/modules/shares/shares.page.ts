/**
 * `GET /s/{shareId}` (API §4.11, outside OpenAPI): the page a shared link opens in a browser. The name, the number
 * of tracks, the list (each track links to YouTube Music), «Открыть в Melogold» (`melogold://share?v=1&url=…&id=…`,
 * API §7.2) and «Слушать на YouTube» (`watch_videos`, the first 50 tracks). Everything is HTML-escaped; no script, no
 * external resource (the same strict CSP as `GET /`), `noindex`.
 */
import type { TrackDto } from "../../contract/common.ts";
import { escapeHtml } from "../server/landing.ts";
import type { LandingLocale } from "../server/landing.ts";

/** YouTube's `watch_videos` takes at most 50 ids. */
export const WATCH_VIDEOS_MAX = 50;

export type SharePageInput = Readonly<{
  /** `null`: the snapshot does not exist (the 404 page). */
  share: Readonly<{ id: string; name: string; tracks: readonly TrackDto[] }> | null;
  /** Base URL of this server without a trailing `/`, or `null` when it cannot be told. */
  baseUrl: string | null;
  instanceName: string;
  locale: LandingLocale;
}>;

const TEXT = {
  ru: {
    open: "Открыть в Melogold",
    youTube: "Слушать на YouTube",
    youTubeHint: "Первые 50 треков",
    hint: "Кнопка откроет приложение Melogold: плейлист можно послушать и сохранить в Библиотеку.",
    missing: "Ссылка удалена или неверна",
    missingHint: "Попросите прислать ссылку ещё раз.",
    shared: "Плейлист по ссылке",
  },
  en: {
    open: "Open in Melogold",
    youTube: "Listen on YouTube",
    youTubeHint: "The first 50 tracks",
    hint: "The button opens the Melogold app: listen to the playlist and save it to your Library.",
    missing: "The link was deleted or is wrong",
    missingHint: "Ask for the link again.",
    shared: "Shared playlist",
  },
} as const;

/** «1 трек», «2 трека», «5 треков» / "1 track", "2 tracks". */
export function tracksCount(count: number, locale: LandingLocale): string {
  if (locale === "en") return `${count} ${count === 1 ? "track" : "tracks"}`;
  const tens = count % 100;
  const ones = count % 10;
  const word = tens >= 11 && tens <= 14 ? "треков" : ones === 1 ? "трек" : ones >= 2 && ones <= 4 ? "трека" : "треков";
  return `${count} ${word}`;
}

function duration(track: TrackDto): string {
  if (track.durationText !== null) return track.durationText;
  if (track.durationMs === null) return "";
  const seconds = Math.floor(track.durationMs / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function shareDeepLink(baseUrl: string, id: string): string {
  return `melogold://share?v=1&url=${encodeURIComponent(baseUrl)}&id=${encodeURIComponent(id)}`;
}

export function watchVideosUrl(tracks: readonly TrackDto[]): string {
  const ids = tracks.slice(0, WATCH_VIDEOS_MAX).map((track) => track.videoId);
  return `https://www.youtube.com/watch_videos?video_ids=${ids.join(",")}`;
}

/** The HTML of `GET /s/{shareId}`. */
export function renderSharePage(input: SharePageInput): string {
  const t = TEXT[input.locale];
  const share = input.share;
  const title = share === null ? t.missing : share.name;
  const body =
    share === null
      ? `<p class="lead">${t.missingHint}</p>`
      : `<p class="lead">${escapeHtml(t.shared)} · ${tracksCount(share.tracks.length, input.locale)}</p>
<p class="actions">${
          input.baseUrl === null
            ? ""
            : `<a class="button" href="${escapeHtml(shareDeepLink(input.baseUrl, share.id))}">${t.open}</a> `
        }<a class="button secondary" href="${escapeHtml(watchVideosUrl(share.tracks))}">${t.youTube}</a></p>
<p class="hint">${t.hint}${share.tracks.length > WATCH_VIDEOS_MAX ? ` ${t.youTube}: ${t.youTubeHint}.` : ""}</p>
<ol>
${share.tracks
  .map((track) => {
    const who = track.artistsText === null ? "" : `${escapeHtml(track.artistsText)} — `;
    const time = duration(track);
    return `<li><a href="https://music.youtube.com/watch?v=${escapeHtml(track.videoId)}">${who}${escapeHtml(track.title)}</a>${time === "" ? "" : ` <span class="time">${escapeHtml(time)}</span>`}</li>`;
  })
  .join("\n")}
</ol>`;
  return `<!doctype html>
<html lang="${input.locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light dark; --accent: #fe6b08; }
body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0 auto; max-width: 36rem; padding: 2rem 1rem; line-height: 1.5; }
h1 { margin-bottom: 0.25rem; }
.lead { margin-top: 0; opacity: 0.75; }
.actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.button { display: inline-block; padding: 0.75rem 1.5rem; border-radius: 0.75rem; background: var(--accent); color: #fff; text-decoration: none; font-weight: 600; }
.button.secondary { background: transparent; color: inherit; border: 1px solid currentColor; }
.hint, footer, .time { font-size: 0.875rem; opacity: 0.75; }
ol { padding-left: 1.5rem; }
li { margin: 0.25rem 0; }
li a { color: inherit; text-decoration: none; }
footer a { color: inherit; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${body}
<footer><p>${escapeHtml(input.instanceName)} · Melogold</p></footer>
</body>
</html>
`;
}
