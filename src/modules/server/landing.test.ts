/** `GET /` (API §3 row 1, §7.2): base URL, deep link, escaping, language. */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { renderDocsPage } from "./docs-page.ts";
import { escapeHtml, landingBaseUrl, landingLocale, renderLandingPage, serverDeepLink } from "./landing.ts";

const SERVER_ID = "6f1c2c0e-8a3b-4f7e-9c1d-2b5e7a9f0c11";

describe("landing page", () => {
  test("base URL: PUBLIC_URL, else the request origin when the host is plain", () => {
    assert.equal(landingBaseUrl("https://music.example.com", "http", "evil.test"), "https://music.example.com");
    assert.equal(landingBaseUrl(null, "http", "192.168.1.50:8080"), "http://192.168.1.50:8080");
    assert.equal(landingBaseUrl(null, "https", "Music.Example.COM"), "https://music.example.com");
    assert.equal(landingBaseUrl(null, "http", "[fd00::1]:8080"), "http://[fd00::1]:8080");
    assert.equal(landingBaseUrl(null, "http", '"><script>'), null);
    assert.equal(landingBaseUrl(null, "http", undefined), null);
  });

  test("deep link of API §7.2 with percent-encoding", () => {
    assert.equal(
      serverDeepLink("http://192.168.1.50:8080", SERVER_ID),
      `melogold://server?v=1&url=http%3A%2F%2F192.168.1.50%3A8080&sid=${SERVER_ID}`,
    );
  });

  test("language from Accept-Language", () => {
    assert.equal(landingLocale("ru-RU,ru;q=0.9,en;q=0.8"), "ru");
    assert.equal(landingLocale("ru"), "ru");
    assert.equal(landingLocale("en-US,ru;q=0.5"), "en");
    assert.equal(landingLocale(undefined), "en");
  });

  test("everything is escaped", () => {
    assert.equal(escapeHtml(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
    const html = renderLandingPage({
      instanceName: "<b>Home</b>",
      baseUrl: "http://192.168.1.50:8080",
      serverId: SERVER_ID,
      version: "0.1.0",
      sourceUrl: "https://github.com/melogold-app/melogoldServer/tree/abc",
      privacyUrl: null,
      contact: "admin@example.com",
      locale: "ru",
    });
    assert.ok(html.includes("&lt;b&gt;Home&lt;/b&gt;"));
    assert.ok(!html.includes("<b>Home</b>"));
    assert.ok(
      html.includes(`href="melogold://server?v=1&amp;url=http%3A%2F%2F192.168.1.50%3A8080&amp;sid=${SERVER_ID}"`),
    );
    assert.ok(html.includes("Открыть в Melogold"));
    assert.ok(!html.includes("<script"));
  });

  test("without an address the page explains how to connect", () => {
    const html = renderLandingPage({
      instanceName: "Melogold",
      baseUrl: null,
      serverId: SERVER_ID,
      version: "0.1.0",
      sourceUrl: "https://example.com/src",
      privacyUrl: "https://example.com/privacy",
      contact: null,
      locale: "en",
    });
    assert.ok(!html.includes("melogold://"));
    assert.ok(html.includes("PUBLIC_URL"));
    assert.ok(html.includes('href="https://example.com/privacy"'));
  });

  test("docs page lists operations by tag, escaped", () => {
    const html = renderDocsPage({
      info: { title: "Melogold API", version: "1", description: "<script>alert(1)</script>" },
      tags: [{ name: "server", description: "Health" }],
      paths: {
        "/server/info": {
          get: {
            operationId: "getServerInfo",
            summary: "Discovery",
            tags: ["server"],
            security: [],
            responses: { "200": {} },
          },
        },
      },
    });
    assert.ok(html.includes("<code>getServerInfo</code>"));
    assert.ok(html.includes("&lt;script&gt;"));
    assert.ok(!html.includes("<script>"));
  });
});
