import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  base64UrlDecode,
  base64UrlEncode,
  constantTimeEqual,
  hmacSha256,
  randomBase64Url,
  sha256,
  sha256Hex,
} from "./crypto.ts";

describe("sha256", () => {
  test("FIPS 180-2 vectors, strings hashed as UTF-8", () => {
    assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert.equal(sha256Hex("é"), sha256Hex(Buffer.from([0xc3, 0xa9])));
    assert.equal(sha256("abc").toString("hex"), sha256Hex("abc"));
  });
});

describe("hmacSha256", () => {
  test("RFC 4231 test case 2", () => {
    assert.equal(
      hmacSha256("Jefe", "what do ya want for nothing?").toString("hex"),
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });

  test("jwt.io HS256 example signature", () => {
    const input =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
      "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ";
    assert.equal(
      base64UrlEncode(hmacSha256("your-256-bit-secret", input)),
      "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    );
  });
});

describe("constantTimeEqual", () => {
  test("equal, different and different-length strings", () => {
    assert.equal(constantTimeEqual("abc", "abc"), true);
    assert.equal(constantTimeEqual("abc", "abd"), false);
    assert.equal(constantTimeEqual("abc", "abcd"), false);
    assert.equal(constantTimeEqual("", ""), true);
    assert.equal(constantTimeEqual("ё", "е"), false);
  });
});

describe("base64url", () => {
  test("round trip without padding", () => {
    for (const text of ["", "f", "fo", "foo", "foob", "fooba", "foobar", "ü€𝄞"]) {
      const encoded = base64UrlEncode(text);
      assert.doesNotMatch(encoded, /[=+/]/);
      assert.equal(base64UrlDecode(encoded)?.toString("utf8"), text);
    }
    assert.equal(base64UrlEncode(Buffer.from([0xfb, 0xff])), "-_8");
  });

  test("strict decoding: alphabet, length and canonical form", () => {
    assert.equal(base64UrlDecode("Zm9v=="), null, "padding");
    assert.equal(base64UrlDecode("Zm+v"), null, "standard alphabet");
    assert.equal(base64UrlDecode("Zm9 v"), null, "space");
    assert.equal(base64UrlDecode("Z"), null, "impossible length");
    assert.equal(base64UrlDecode("Zh"), null, "non-zero trailing bits");
    assert.deepEqual(base64UrlDecode("Zg"), Buffer.from("f"));
    assert.deepEqual(base64UrlDecode(""), Buffer.alloc(0));
  });

  test("randomBase64Url: 32 bytes are 43 characters, values differ", () => {
    const a = randomBase64Url(32);
    const b = randomBase64Url(32);
    assert.match(a, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(a, b);
    assert.throws(() => randomBase64Url(0), RangeError);
  });
});
