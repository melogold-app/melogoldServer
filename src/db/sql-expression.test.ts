/** Canonical `CHECK` and partial-index expressions (`sql-expression.ts`), used by the schema check. */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { loadSchemaSnapshot } from "./schema-check.ts";
import {
  SqlExpressionError,
  canonicalExpression,
  checkExpressions,
  comparableExpression,
  partialIndexPredicate,
} from "./sql-expression.ts";

/** As written in the migrations (and stored by SQLite) → as PostgreSQL 18 deparses it (`pg_get_constraintdef`). */
const SAME: readonly (readonly [string, string])[] = [
  ["length(login) BETWEEN 3 AND 64", "((length(login) >= 3) AND (length(login) <= 64))"],
  ["length(recovery_code_hash) = 64", "(length(recovery_code_hash) = 64)"],
  [
    "custom_name IS NULL OR length(custom_name) BETWEEN 1 AND 64",
    "((custom_name IS NULL) OR ((length(custom_name) >= 1) AND (length(custom_name) <= 64)))",
  ],
  ["deleted IN (0,1)", "(deleted = ANY (ARRAY[0, 1]))"],
  ["video_id = '*' OR length(video_id) = 11", "((video_id = '*'::text) OR (length(video_id) = 11))"],
  ["deleted = 0 AND browse_id IS NOT NULL", "((deleted = 0) AND (browse_id IS NOT NULL))"],
  ["queue_version >= 0", "(queue_version >= 0)"],
  ["a AND b AND c", "((a AND b) AND c)"],
  ["a != 1", '("a" <> 1)'],
  ["x = 'it''s'", "(x = 'it''s'::character varying COLLATE \"C\")"],
  ["x IN (1, 2)", "(x = ANY ((ARRAY[1, 2])::integer[]))"],
  ["x NOT BETWEEN 1 AND 2", "(NOT ((x >= 1) AND (x <= 2)))"],
];

const DIFFERENT: readonly (readonly [string, string])[] = [
  ["length(login) BETWEEN 3 AND 64", "((length(login) >= 3) AND (length(login) <= 65))"],
  ["deleted_at IS NOT NULL", "(deleted_at IS NULL)"],
  ["a AND (b OR c)", "((a AND b) OR c)"],
  ["deleted IN (0,1)", "(deleted = ANY (ARRAY[0, 1, 2]))"],
  ["x = 1", "(1 = x)"],
  ["length(a) = 1", "(length(b) = 1)"],
];

describe("canonicalExpression", () => {
  test("the migration's spelling and PostgreSQL's deparsed spelling are equal", () => {
    for (const [written, deparsed] of SAME) {
      assert.equal(canonicalExpression(written), canonicalExpression(deparsed), `${written} ≡ ${deparsed}`);
    }
    assert.equal(
      canonicalExpression("length(login) BETWEEN 3 AND 64"),
      "((length(login) >= 3) AND (length(login) <= 64))",
    );
  });

  test("different constraints stay different", () => {
    for (const [left, right] of DIFFERENT) {
      assert.notEqual(canonicalExpression(left), canonicalExpression(right), `${left} ≢ ${right}`);
    }
  });

  test("every CHECK and index predicate of the snapshot parses", () => {
    const snapshot = loadSchemaSnapshot();
    let count = 0;
    for (const table of Object.values(snapshot.tables)) {
      for (const expression of [...table.checks, ...table.indexes.flatMap((index) => index.where ?? [])]) {
        assert.doesNotThrow(() => canonicalExpression(expression), expression);
        count++;
      }
    }
    assert.ok(count > 30);
  });

  test("unsupported syntax throws; comparableExpression falls back to the text, never equal to a parsed one", () => {
    assert.throws(() => canonicalExpression("a + 1 > 2"), SqlExpressionError);
    assert.throws(() => canonicalExpression("(a = 1"), SqlExpressionError);
    assert.throws(() => canonicalExpression("a = ANY (b)"), SqlExpressionError);
    assert.equal(comparableExpression("a  +  1 > 2"), "unparsed: a + 1 > 2");
    assert.equal(comparableExpression("a = 1"), "(a = 1)");
  });
});

describe("SQLite schema text", () => {
  test("checkExpressions finds every CHECK, with nested brackets, outside quoted text", () => {
    const table = `CREATE TABLE t (
      id TEXT NOT NULL PRIMARY KEY,
      note TEXT NOT NULL DEFAULT 'CHECK (x)' CHECK (length(note) BETWEEN 1 AND 64),
      "check" INTEGER NOT NULL CHECK ("check" IN (0,1)),
      v TEXT NULL check(v IS NULL OR (length(v) = 11))
    ) STRICT`;
    assert.deepEqual(checkExpressions(table), [
      "length(note) BETWEEN 1 AND 64",
      '"check" IN (0,1)',
      "v IS NULL OR (length(v) = 11)",
    ]);
    assert.deepEqual(checkExpressions("CREATE TABLE t (id TEXT NOT NULL PRIMARY KEY) STRICT"), []);
  });

  test("partialIndexPredicate returns the WHERE of a partial index, null otherwise", () => {
    assert.equal(
      partialIndexPredicate("CREATE INDEX users_deleted ON users (deleted_at) WHERE deleted_at IS NOT NULL"),
      "deleted_at IS NOT NULL",
    );
    assert.equal(
      partialIndexPredicate("CREATE INDEX i ON t (a, b) WHERE deleted = 0 AND (b IS NOT NULL)"),
      "deleted = 0 AND (b IS NOT NULL)",
    );
    assert.equal(partialIndexPredicate("CREATE UNIQUE INDEX sync_ops_op ON sync_ops (user_id, op_id)"), null);
  });
});
