/**
 * `GET /` (API §3 row 1, outside OpenAPI): the page a phone camera opens from the server QR code (API §7.2: the QR is
 * the base URL itself). It shows the instance name and address and a button with the deep link
 * `melogold://server?v=1&url=<base, percent-encoded>&sid=<serverId>`, which opens the app on "Own server" with the
 * address filled in and a confirmation (API §7.2, never an automatic login).
 *
 * The base URL is `PUBLIC_URL`, otherwise the address the request came to (`request.protocol` + `Host`, through
 * `TRUST_PROXY`) when it looks like a plain host. Everything is HTML-escaped; the page loads nothing from outside and
 * has no script (a strict `Content-Security-Policy` comes with it).
 */

export type LandingLocale = "ru" | "en";

export type LandingInput = Readonly<{
  instanceName: string;
  /** Base URL without a trailing `/`, or `null` when it cannot be told. */
  baseUrl: string | null;
  serverId: string;
  version: string;
  sourceUrl: string;
  privacyUrl: string | null;
  contact: string | null;
  locale: LandingLocale;
}>;

/** CSP of the page: inline styles only. */
export const LANDING_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const HOST_PATTERN =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

/** The base URL of the page: `PUBLIC_URL`, or the request's own origin when its host is well-formed. */
export function landingBaseUrl(publicUrl: string | null, protocol: string, host: string | undefined): string | null {
  if (publicUrl !== null) return publicUrl;
  if (host === undefined || !HOST_PATTERN.test(host)) return null;
  if (protocol !== "http" && protocol !== "https") return null;
  return `${protocol}://${host.toLowerCase()}`;
}

/** The deep link of API §7.2. */
export function serverDeepLink(baseUrl: string, serverId: string): string {
  return `melogold://server?v=1&url=${encodeURIComponent(baseUrl)}&sid=${encodeURIComponent(serverId)}`;
}

/** `ru` when the first preferred language is Russian, else `en`. */
export function landingLocale(acceptLanguage: string | undefined): LandingLocale {
  const first = (acceptLanguage ?? "").split(",")[0]?.trim().toLowerCase() ?? "";
  return first === "ru" || first.startsWith("ru-") ? "ru" : "en";
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const TEXT = {
  ru: {
    lead: "Сервер синхронизации Melogold",
    open: "Открыть в Melogold",
    hint: "Кнопка откроет приложение на экране «Свой сервер» с этим адресом. Если приложение не открылось, введите адрес вручную.",
    noAddress:
      "Адрес сервера не настроен (PUBLIC_URL). Введите в приложении адрес, по которому вы открыли эту страницу.",
    address: "Адрес",
    source: "Исходный код",
    privacy: "Конфиденциальность",
    contact: "Контакт",
  },
  en: {
    lead: "Melogold sync server",
    open: "Open in Melogold",
    hint: 'The button opens the app on the "Own server" screen with this address. If the app does not open, enter the address by hand.',
    noAddress: "The server address is not configured (PUBLIC_URL). Enter the address of this page in the app.",
    address: "Address",
    source: "Source code",
    privacy: "Privacy",
    contact: "Contact",
  },
} as const;

/** The HTML of `GET /`. */
export function renderLandingPage(input: LandingInput): string {
  const t = TEXT[input.locale];
  const name = escapeHtml(input.instanceName);
  const links = [
    `<a href="${escapeHtml(input.sourceUrl)}">${t.source}</a>`,
    ...(input.privacyUrl === null ? [] : [`<a href="${escapeHtml(input.privacyUrl)}">${t.privacy}</a>`]),
    ...(input.contact === null ? [] : [`${t.contact}: ${escapeHtml(input.contact)}`]),
  ];
  const body =
    input.baseUrl === null
      ? `<p>${t.noAddress}</p>`
      : `<p class="address">${t.address}: <code>${escapeHtml(input.baseUrl)}</code></p>
<p><a class="button" href="${escapeHtml(serverDeepLink(input.baseUrl, input.serverId))}">${t.open}</a></p>
<p class="hint">${t.hint}</p>`;
  return `<!doctype html>
<html lang="${input.locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${name}</title>
<style>
:root { color-scheme: light dark; --accent: #fe6b08; }
body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0 auto; max-width: 32rem; padding: 2rem 1rem; line-height: 1.5; }
h1 { margin-bottom: 0.25rem; }
.lead { margin-top: 0; opacity: 0.75; }
code { word-break: break-all; }
.button { display: inline-block; padding: 0.75rem 1.5rem; border-radius: 0.75rem; background: var(--accent); color: #fff; text-decoration: none; font-weight: 600; }
.hint, footer { font-size: 0.875rem; opacity: 0.75; }
footer a { color: inherit; }
</style>
</head>
<body>
<h1>${name}</h1>
<p class="lead">${t.lead} ${escapeHtml(input.version)}</p>
${body}
<footer><p>${links.join(" · ")}</p></footer>
</body>
</html>
`;
}
