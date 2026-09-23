import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LruSet } from "./lru.ts";

describe("LruSet", () => {
  test("evicts the least recently used value", () => {
    const set = new LruSet<string>(2);
    set.add("a").add("b");
    assert.equal(set.has("a"), true); // "a" is now the most recent
    set.add("c"); // evicts "b"
    assert.equal(set.has("b"), false);
    assert.equal(set.has("a"), true);
    assert.equal(set.has("c"), true);
    assert.equal(set.size, 2);
  });

  test("re-adding refreshes, delete and clear", () => {
    const set = new LruSet<number>(2);
    set.add(1).add(2).add(1).add(3);
    assert.equal(set.has(2), false);
    assert.equal(set.has(1), true);
    assert.equal(set.delete(1), true);
    assert.equal(set.delete(1), false);
    set.clear();
    assert.equal(set.size, 0);
  });

  test("capacity must be positive", () => {
    assert.throws(() => new LruSet(0), RangeError);
  });
});
