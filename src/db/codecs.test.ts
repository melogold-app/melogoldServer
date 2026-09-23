import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { z } from "zod";
import { CodecError, fromDbBool, jsonCodec, safeInt, safeIntegerNumeric, toDbBool } from "./codecs.ts";

describe("jsonCodec", () => {
  const codec = jsonCodec(z.object({ name: z.string(), videoIds: z.array(z.string()) }), "pre_image");

  test("round-trips a valid document", () => {
    const text = codec.encode({ name: "Mix", videoIds: ["dQw4w9WgXcQ"] });
    assert.equal(text, '{"name":"Mix","videoIds":["dQw4w9WgXcQ"]}');
    assert.deepEqual(codec.decode(text), { name: "Mix", videoIds: ["dQw4w9WgXcQ"] });
  });

  test("refuses to write or read an invalid document", () => {
    assert.throws(() => codec.encode({ name: 1 } as never), CodecError);
    assert.throws(() => codec.decode('{"name":"x"}'), /pre_image: cannot decode an invalid document \(videoIds/);
    assert.throws(() => codec.decode("{not json"), /stored text is not JSON/);
  });

  test("nullable helpers pass null through", () => {
    assert.equal(codec.encodeNullable(null), null);
    assert.equal(codec.decodeNullable(null), null);
    assert.deepEqual(codec.decodeNullable('{"name":"a","videoIds":[]}'), { name: "a", videoIds: [] });
  });
});

describe("BOOL", () => {
  test("0 | 1 in the database, boolean in the code", () => {
    assert.equal(toDbBool(true), 1);
    assert.equal(toDbBool(false), 0);
    assert.equal(fromDbBool(1), true);
    assert.equal(fromDbBool(0), false);
    assert.throws(() => fromDbBool(2), CodecError);
  });
});

describe("pg type parsers", () => {
  test("safeInt: bigint text → number within ±(2^53 − 1)", () => {
    assert.equal(safeInt("0"), 0);
    assert.equal(safeInt("-42"), -42);
    assert.equal(safeInt("9007199254740991"), Number.MAX_SAFE_INTEGER);
    assert.equal(safeInt("-9007199254740991"), -Number.MAX_SAFE_INTEGER);
    assert.throws(() => safeInt("9007199254740992"), CodecError);
    assert.throws(() => safeInt("9223372036854775807"), CodecError);
    assert.throws(() => safeInt("1e3"), CodecError);
    assert.throws(() => safeInt(""), CodecError);
  });

  test("safeIntegerNumeric: integers only", () => {
    assert.equal(safeIntegerNumeric("123"), 123);
    assert.equal(safeIntegerNumeric("123.000"), 123);
    assert.throws(() => safeIntegerNumeric("1.5"), CodecError);
    assert.throws(() => safeIntegerNumeric("NaN"), CodecError);
    assert.throws(() => safeIntegerNumeric("99999999999999999999"), CodecError);
  });
});
