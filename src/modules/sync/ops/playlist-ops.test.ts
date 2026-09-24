/**
 * `spec/playlist-ops.vectors.json` (DESIGN §3.7 "Якоря", §3.13.3, §8): every native client re-implements order keys,
 * the longest increasing subsequence and the anchor functions, so this pins the reference TypeScript
 * implementation's exact output against the vectors every port is checked against.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  anchorIndex,
  applyAdd,
  applyCreate,
  applyImport,
  applyMove,
  applyRemove,
  applyReplace,
} from "../playlists/anchors.ts";
import type { Anchors } from "../playlists/anchors.ts";
import { longestIncreasingSubsequence } from "../playlists/lis.ts";
import { compareOrdinal, keyBetween, keysBetween, SortKeyError } from "../playlists/sort-keys.ts";

const vectors = JSON.parse(
  readFileSync(new URL("../../../../spec/playlist-ops.vectors.json", import.meta.url), "utf8"),
) as {
  license: string;
  sortKeys: {
    keyBetween: { a: string | null; b: string | null; key: string }[];
    appendChainFromNull: string[];
    prependChainToA0: string[];
    bisectChainBetweenA0AndA1: string[];
    keysBetween: { a: string | null; b: string | null; n: number; keys: string[] }[];
    errors: { a: string | null; b: string | null }[];
    compareOrdinal: { a: string; b: string; cmp: number }[];
  };
  lis: { values: number[]; indices: number[] }[];
  anchors: {
    anchorIndex: { list: string[]; anchors: Anchors; index: number }[];
    applyAdd: { list: string[]; ids: string[]; anchors: Anchors; result: string[] }[];
    applyRemove: { list: string[]; videoId: string; result: string[] }[];
    applyMove: { list: string[]; videoId: string; anchors: Anchors; result: string[] }[];
    applyReplace: { list: string[]; ids: string[]; result: string[] }[];
    applyImport: { list: string[]; ids: string[]; result: string[] }[];
    applyCreate: { list: string[]; ids: string[]; result: string[] }[];
  };
};

describe("spec/playlist-ops.vectors.json", () => {
  test("published as CC0-1.0", () => {
    assert.equal(vectors.license, "CC0-1.0");
  });

  test("sort keys: keyBetween", () => {
    for (const c of vectors.sortKeys.keyBetween) assert.equal(keyBetween(c.a, c.b), c.key, JSON.stringify(c));
  });

  test("sort keys: append, prepend and bisection chains grow as documented", () => {
    let appended: string | null = null;
    for (const expected of vectors.sortKeys.appendChainFromNull) {
      appended = keyBetween(appended, null);
      assert.equal(appended, expected);
    }
    let prepended: string | null = "a0";
    for (const expected of vectors.sortKeys.prependChainToA0) {
      prepended = keyBetween(null, prepended);
      assert.equal(prepended, expected);
    }
    let lower = "a0";
    for (const expected of vectors.sortKeys.bisectChainBetweenA0AndA1) {
      lower = keyBetween(lower, "a1");
      assert.equal(lower, expected);
    }
  });

  test("sort keys: keysBetween", () => {
    for (const c of vectors.sortKeys.keysBetween)
      assert.deepEqual(keysBetween(c.a, c.b, c.n), c.keys, JSON.stringify(c));
  });

  test("sort keys: malformed or out-of-order bounds throw SortKeyError", () => {
    for (const c of vectors.sortKeys.errors) {
      assert.throws(() => keyBetween(c.a, c.b), SortKeyError, JSON.stringify(c));
    }
  });

  test("sort keys: compareOrdinal", () => {
    for (const c of vectors.sortKeys.compareOrdinal) {
      assert.equal(Math.sign(compareOrdinal(c.a, c.b)), c.cmp, JSON.stringify(c));
    }
  });

  test("longest increasing subsequence", () => {
    for (const c of vectors.lis) assert.deepEqual(longestIncreasingSubsequence(c.values), c.indices, JSON.stringify(c));
  });

  test("anchorIndex", () => {
    for (const c of vectors.anchors.anchorIndex)
      assert.equal(anchorIndex(c.list, c.anchors), c.index, JSON.stringify(c));
  });

  test("applyAdd", () => {
    for (const c of vectors.anchors.applyAdd) {
      assert.deepEqual(applyAdd(c.list, c.ids, c.anchors), c.result, JSON.stringify(c));
    }
  });

  test("applyRemove", () => {
    for (const c of vectors.anchors.applyRemove)
      assert.deepEqual(applyRemove(c.list, c.videoId), c.result, JSON.stringify(c));
  });

  test("applyMove", () => {
    for (const c of vectors.anchors.applyMove) {
      assert.deepEqual(applyMove(c.list, c.videoId, c.anchors), c.result, JSON.stringify(c));
    }
  });

  test("applyReplace", () => {
    for (const c of vectors.anchors.applyReplace)
      assert.deepEqual(applyReplace(c.list, c.ids), c.result, JSON.stringify(c));
  });

  test("applyImport", () => {
    for (const c of vectors.anchors.applyImport)
      assert.deepEqual(applyImport(c.list, c.ids), c.result, JSON.stringify(c));
  });

  test("applyCreate", () => {
    for (const c of vectors.anchors.applyCreate)
      assert.deepEqual(applyCreate(c.list, c.ids), c.result, JSON.stringify(c));
  });
});
