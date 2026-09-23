import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, test } from "node:test";
import { base64UrlEncode } from "./crypto.ts";
import {
  LINK_TOKEN_PATTERN,
  POLL_SECRET_PATTERN,
  REFRESH_TOKEN_MAX_LENGTH,
  hashToken,
  isRefreshTokenExpired,
  newLinkToken,
  newPollSecret,
  openCompact,
  parseRefreshToken,
  refreshTokenMatchesRow,
  signAccessToken,
  signCompact,
  signRefreshToken,
  verifyAccessToken,
} from "./tokens.ts";

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 8);
const USER = "0c3f6a2e-5d1b-4c7a-9e8f-1a2b3c4d5e6f";
const DEVICE = "9b1e2f4a-7c3d-4e5f-8a9b-0c1d2e3f4a5b";
const TOKEN_ID = "1f2e3d4c-5b6a-4978-8a7b-6c5d4e3f2a1b";
const NOW = Date.UTC(2026, 8, 23, 10, 0, 0, 500);

function segments(token: string): [string, string, string] {
  const parts = token.split(".");
  assert.equal(parts.length, 3);
  return parts as [string, string, string];
}

function json(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

describe("hashToken", () => {
  test("lowercase hex SHA-256", () => {
    assert.equal(hashToken("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("signed compact tokens", () => {
  test("format: prefix.b64url(JSON).b64url(HMAC(key, prefix.payload))", () => {
    const token = signCompact("mgpow1", { n: "abc", b: 18 }, KEY);
    const [prefix, payload, signature] = segments(token);
    assert.equal(prefix, "mgpow1");
    assert.deepEqual(json(payload), { n: "abc", b: 18 });
    const expected = createHmac("sha256", KEY).update(`mgpow1.${payload}`).digest("base64url");
    assert.equal(signature, expected);
    assert.deepEqual(openCompact("mgpow1", token, KEY, 256), { n: "abc", b: 18 });
  });

  test("deterministic", () => {
    assert.equal(signCompact("x", { a: 1 }, KEY), signCompact("x", { a: 1 }, KEY));
  });

  test("rejects a wrong key, prefix, tampering and length", () => {
    const token = signCompact("mgpow1", { a: 1 }, KEY);
    assert.equal(openCompact("mgpow1", token, OTHER_KEY, 256), null);
    assert.equal(openCompact("mgrt1", token, KEY, 256), null);
    assert.equal(openCompact("mgpow1", token, KEY, token.length - 1), null);
    const [prefix, payload, signature] = segments(token);
    const forged = base64UrlEncode(JSON.stringify({ a: 2 }));
    assert.equal(openCompact("mgpow1", `${prefix}.${forged}.${signature}`, KEY, 256), null);
    assert.equal(openCompact("mgpow1", `${prefix}.${payload}.${signature.slice(0, -1)}A`, KEY, 256), null);
    assert.equal(openCompact("mgpow1", `${prefix}.${payload}`, KEY, 256), null);
    assert.equal(openCompact("mgpow1", `${token}.x`, KEY, 256), null);
  });

  test("an authentic payload that is not JSON is rejected", () => {
    const payload = base64UrlEncode("not json");
    const signature = createHmac("sha256", KEY).update(`p.${payload}`).digest("base64url");
    assert.equal(openCompact("p", `p.${payload}.${signature}`, KEY, 256), null);
  });
});

describe("refresh token mgrt1 (DESIGN §4.4)", () => {
  const expiresAt = NOW + 90 * 86_400_000;
  const input = { tid: TOKEN_ID, sub: USER, did: DEVICE, expiresAt };

  test("payload {typ, tid, sub, did, exp} with exp in seconds; deterministic", () => {
    const token = signRefreshToken(input, KEY);
    assert.match(token, /^mgrt1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    assert.ok(token.length <= REFRESH_TOKEN_MAX_LENGTH);
    const [, payload] = segments(token);
    assert.deepEqual(json(payload), {
      typ: "refresh",
      tid: TOKEN_ID,
      sub: USER,
      did: DEVICE,
      exp: Math.floor(expiresAt / 1000),
    });
    assert.equal(signRefreshToken(input, KEY), token);
  });

  test("parse checks HMAC and shape, not expiry", () => {
    const token = signRefreshToken(input, KEY);
    const parsed = parseRefreshToken(token, KEY);
    assert.ok(parsed);
    assert.equal(parsed.tid, TOKEN_ID);
    assert.equal(parseRefreshToken(token, OTHER_KEY), null);
    const expired = signRefreshToken({ ...input, expiresAt: NOW - 1000 }, KEY);
    const parsedExpired = parseRefreshToken(expired, KEY);
    assert.ok(parsedExpired, "an expired authentic token still parses (logout, rt key)");
    assert.equal(isRefreshTokenExpired(parsedExpired, NOW), true);
    assert.equal(isRefreshTokenExpired(parsed, NOW), false);
  });

  test("rejects authentic tokens with a wrong shape", () => {
    const sign = (payload: object) => signCompact("mgrt1", payload, KEY);
    const exp = Math.floor(expiresAt / 1000);
    assert.equal(parseRefreshToken(sign({ typ: "access", tid: TOKEN_ID, sub: USER, did: DEVICE, exp }), KEY), null);
    assert.equal(parseRefreshToken(sign({ typ: "refresh", tid: "x", sub: USER, did: DEVICE, exp }), KEY), null);
    assert.equal(parseRefreshToken(sign({ typ: "refresh", tid: TOKEN_ID, sub: USER, did: null, exp }), KEY), null);
    assert.equal(
      parseRefreshToken(sign({ typ: "refresh", tid: TOKEN_ID, sub: USER, did: DEVICE, exp: 1.5 }), KEY),
      null,
    );
    assert.equal(parseRefreshToken(sign([1, 2]), KEY), null);
    assert.equal(parseRefreshToken("mgrt1.x.y", KEY), null);
    assert.equal(parseRefreshToken("", KEY), null);
    assert.equal(parseRefreshToken(`mgrt1.${"A".repeat(1100)}.${"A".repeat(43)}`, KEY), null);
  });

  test("matches its row: id, user, device and expiry second", () => {
    const parsed = parseRefreshToken(signRefreshToken(input, KEY), KEY);
    assert.ok(parsed);
    const row = { id: TOKEN_ID, user_id: USER, device_id: DEVICE, expires_at: expiresAt };
    assert.equal(refreshTokenMatchesRow(parsed, row), true);
    assert.equal(refreshTokenMatchesRow(parsed, { ...row, device_id: USER }), false);
    assert.equal(refreshTokenMatchesRow(parsed, { ...row, user_id: DEVICE }), false);
    assert.equal(refreshTokenMatchesRow(parsed, { ...row, id: USER }), false);
    assert.equal(refreshTokenMatchesRow(parsed, { ...row, expires_at: expiresAt + 1000 }), false);
  });
});

describe("access token: JWT HS256 (API §1.7)", () => {
  const subject = { sub: USER, did: DEVICE, av: 3, rid: TOKEN_ID };

  test("standard JWT: header, claims {sub, did, av, rid, iat, exp}, HMAC-SHA256 signature", () => {
    const signed = signAccessToken(subject, KEY, { now: NOW, ttlSeconds: 900 });
    const [header, payload, signature] = segments(signed.token);
    assert.deepEqual(json(header), { alg: "HS256", typ: "JWT" });
    assert.equal(header, "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", "the header of API §4.3's example");
    const iat = Math.floor(NOW / 1000);
    assert.deepEqual(json(payload), { sub: USER, did: DEVICE, av: 3, rid: TOKEN_ID, iat, exp: iat + 900 });
    assert.equal(signature, createHmac("sha256", KEY).update(`${header}.${payload}`).digest("base64url"));
    assert.equal(signed.expiresAt, (iat + 900) * 1000);
    assert.deepEqual(signed.claims, { ...subject, iat, exp: iat + 900 });
  });

  test("verify: ok until exp, expired at and after exp", () => {
    const signed = signAccessToken(subject, KEY, { now: NOW, ttlSeconds: 900 });
    const ok = verifyAccessToken(signed.token, KEY, NOW);
    assert.ok(ok.ok);
    assert.deepEqual(ok.claims, signed.claims);
    assert.equal(verifyAccessToken(signed.token, KEY, signed.expiresAt - 1).ok, true);
    assert.deepEqual(verifyAccessToken(signed.token, KEY, signed.expiresAt), { ok: false, reason: "expired" });
  });

  test("invalid: wrong key, alg none, tampered claims, garbage", () => {
    const invalid = { ok: false, reason: "invalid" };
    const signed = signAccessToken(subject, KEY, { now: NOW, ttlSeconds: 900 });
    assert.deepEqual(verifyAccessToken(signed.token, OTHER_KEY, NOW), invalid);
    const [header, payload, signature] = segments(signed.token);

    const none = base64UrlEncode(JSON.stringify({ alg: "none", typ: "JWT" }));
    assert.deepEqual(verifyAccessToken(`${none}.${payload}.`, KEY, NOW), invalid);
    assert.deepEqual(verifyAccessToken(`${none}.${payload}.${signature}`, KEY, NOW), invalid);

    const elevated = base64UrlEncode(JSON.stringify({ ...(json(payload) as object), av: 4 }));
    assert.deepEqual(verifyAccessToken(`${header}.${elevated}.${signature}`, KEY, NOW), invalid);

    for (const garbage of ["", "a.b", "a.b.c.d", "Bearer x", `${header}.${payload}`, `${signed.token}x`]) {
      assert.deepEqual(verifyAccessToken(garbage, KEY, NOW), invalid, garbage);
    }
  });

  test("an expired forgery is invalid, not expired", () => {
    const signed = signAccessToken(subject, OTHER_KEY, { now: NOW - 3_600_000, ttlSeconds: 900 });
    assert.deepEqual(verifyAccessToken(signed.token, KEY, NOW), { ok: false, reason: "invalid" });
  });

  test("authentic tokens with bad claims are invalid", () => {
    const craft = (claims: object) => {
      const header = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
      const payload = base64UrlEncode(JSON.stringify(claims));
      return `${header}.${payload}.${createHmac("sha256", KEY).update(`${header}.${payload}`).digest("base64url")}`;
    };
    const iat = Math.floor(NOW / 1000);
    const good = { sub: USER, did: DEVICE, av: 1, rid: TOKEN_ID, iat, exp: iat + 900 };
    assert.equal(verifyAccessToken(craft(good), KEY, NOW).ok, true);
    for (const bad of [
      { ...good, sub: USER.toUpperCase() },
      { ...good, did: undefined },
      { ...good, rid: 5 },
      { ...good, av: 0 },
      { ...good, av: 2_147_483_648 },
      { ...good, av: "1" },
      { ...good, exp: iat },
      { ...good, iat: undefined },
    ]) {
      assert.deepEqual(verifyAccessToken(craft(bad), KEY, NOW), { ok: false, reason: "invalid" }, JSON.stringify(bad));
    }
  });

  test("ttl must be positive", () => {
    assert.throws(() => signAccessToken(subject, KEY, { now: NOW, ttlSeconds: 0 }), RangeError);
  });
});

describe("random secrets (DESIGN §4.10.2)", () => {
  test("poll secret mgps_ + 43, link token 43, all different", () => {
    const secrets = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const secret = newPollSecret();
      const link = newLinkToken();
      assert.match(secret, POLL_SECRET_PATTERN);
      assert.match(link, LINK_TOKEN_PATTERN);
      secrets.add(secret).add(link);
    }
    assert.equal(secrets.size, 100);
  });
});
