/**
 * `GET /docs` (API §3, only with `OPENAPI_DOCS_UI=true`): a plain HTML index of the OpenAPI document, grouped by
 * tag, with a link to `openapi.json`. It is rendered on the server from the same document as `GET /openapi.json`,
 * loads nothing from outside and has no script, so it works on an offline LAN server.
 */
import { escapeHtml } from "./landing.ts";

type Operation = Readonly<{
  operationId?: string;
  summary?: string;
  tags?: readonly string[];
  security?: readonly Record<string, readonly string[]>[];
  responses?: Readonly<Record<string, unknown>>;
}>;

type Document = Readonly<{
  info?: Readonly<{ title?: string; version?: string; description?: string }>;
  tags?: readonly Readonly<{ name: string; description?: string }>[];
  paths?: Readonly<Record<string, Readonly<Record<string, Operation>>>>;
}>;

const METHODS = ["get", "put", "post", "delete", "patch"];

export function renderDocsPage(document: Document): string {
  const byTag = new Map<string, string[]>();
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const method of METHODS) {
      const op = item[method];
      if (op === undefined) continue;
      const tag = op.tags?.[0] ?? "other";
      const auth = (op.security?.length ?? 0) > 0 ? "Bearer" : "public";
      const statuses = Object.keys(op.responses ?? {}).join(" ");
      const row = `<tr><td><code>${method.toUpperCase()}</code></td><td><code>${escapeHtml(path)}</code></td><td><code>${escapeHtml(op.operationId ?? "")}</code></td><td>${escapeHtml(op.summary ?? "")}</td><td>${auth}</td><td>${escapeHtml(statuses)}</td></tr>`;
      byTag.set(tag, [...(byTag.get(tag) ?? []), row]);
    }
  }
  const sections = (document.tags ?? [])
    .filter((tag) => byTag.has(tag.name))
    .map(
      (tag) => `<h2>${escapeHtml(tag.name)}</h2>
<p>${escapeHtml(tag.description ?? "")}</p>
<table><thead><tr><th>Method</th><th>Path</th><th>operationId</th><th>Summary</th><th>Auth</th><th>Responses</th></tr></thead>
<tbody>${(byTag.get(tag.name) ?? []).join("\n")}</tbody></table>`,
    )
    .join("\n");
  const title = escapeHtml(document.info?.title ?? "API");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>
:root { color-scheme: light dark; }
body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0 auto; max-width: 72rem; padding: 1.5rem 1rem; }
table { border-collapse: collapse; width: 100%; font-size: 0.875rem; }
th, td { text-align: left; padding: 0.25rem 0.5rem; border-bottom: 1px solid color-mix(in srgb, currentColor 20%, transparent); vertical-align: top; }
</style>
</head>
<body>
<h1>${title} ${escapeHtml(document.info?.version ?? "")}</h1>
<p>${escapeHtml(document.info?.description ?? "")}</p>
<p>Machine-readable: <a href="openapi.json">openapi.json</a> (OpenAPI 3.0.3).</p>
${sections}
</body>
</html>
`;
}
