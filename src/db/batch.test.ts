import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DELETE_BATCH_ROWS,
  INSERT_BATCH_ROWS,
  IN_BATCH_VALUES,
  chunks,
  deleteInBatches,
  insertInChunks,
  selectInChunks,
} from "./batch.ts";

describe("batch sizes (DESIGN §6.2)", () => {
  test("500 rows per insert, 1000 IN values, 5000 deleted rows per transaction", () => {
    assert.equal(INSERT_BATCH_ROWS, 500);
    assert.equal(IN_BATCH_VALUES, 1000);
    assert.equal(DELETE_BATCH_ROWS, 5000);
  });
});

describe("chunks", () => {
  test("splits without empty chunks", () => {
    assert.deepEqual(chunks([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.deepEqual(chunks([], 3), []);
    assert.throws(() => chunks([1], 0), RangeError);
  });
});

describe("selectInChunks", () => {
  test("never runs a query for an empty list, deduplicates, respects the chunk size", async () => {
    const seen: number[][] = [];
    const query = (chunk: number[]) => {
      seen.push(chunk);
      return Promise.resolve(chunk.map((value) => value * 10));
    };
    assert.deepEqual(await selectInChunks([], query), []);
    assert.equal(seen.length, 0);
    const values = Array.from({ length: 2500 }, (_, index) => index % 2100);
    const rows = await selectInChunks(values, query);
    assert.equal(rows.length, 2100);
    assert.deepEqual(
      seen.map((chunk) => chunk.length),
      [1000, 1000, 100],
    );
  });
});

describe("insertInChunks", () => {
  test("500 rows per statement", async () => {
    const sizes: number[] = [];
    await insertInChunks(
      Array.from({ length: 1201 }, (_, index) => index),
      (chunk) => {
        sizes.push(chunk.length);
        return Promise.resolve();
      },
    );
    assert.deepEqual(sizes, [500, 500, 201]);
  });
});

describe("deleteInBatches", () => {
  test("repeats until a batch deletes fewer rows than the limit", async () => {
    let remaining = 12_345;
    const limits: number[] = [];
    let pauses = 0;
    const total = await deleteInBatches(
      (limit) => {
        limits.push(limit);
        const deleted = Math.min(limit, remaining);
        remaining -= deleted;
        return Promise.resolve(deleted);
      },
      {
        yieldBetween: () => {
          pauses++;
          return Promise.resolve();
        },
      },
    );
    assert.equal(total, 12_345);
    assert.deepEqual(limits, [5000, 5000, 5000]);
    assert.equal(pauses, 2);
  });

  test("maxBatches bounds one run", async () => {
    const total = await deleteInBatches((limit) => Promise.resolve(limit), { batchSize: 10, maxBatches: 3 });
    assert.equal(total, 30);
  });
});
