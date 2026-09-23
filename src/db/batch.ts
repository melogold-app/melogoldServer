/**
 * Batch sizes and helpers (DESIGN §6.2, docs/database.md):
 * - inserts: at most {@link INSERT_BATCH_ROWS} rows per statement (keeps parameters far below SQLite's 32 766 and
 *   PostgreSQL's 65 535);
 * - `IN (…)`: at most {@link IN_BATCH_VALUES} values per statement, and never an empty list;
 * - background deletes: at most {@link DELETE_BATCH_ROWS} rows per transaction, each batch in its own `db.write`, so the
 *   single SQLite writer is released between batches.
 */

export const INSERT_BATCH_ROWS = 500;
export const IN_BATCH_VALUES = 1000;
export const DELETE_BATCH_ROWS = 5000;

/** Splits `items` into consecutive chunks of at most `size` elements (no empty chunks). */
export function chunks<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isSafeInteger(size) || size < 1) throw new RangeError(`chunk size must be a positive integer: ${size}`);
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += size) result.push(items.slice(start, start + size));
  return result;
}

/**
 * Runs `query` for each chunk of at most {@link IN_BATCH_VALUES} distinct values and concatenates the rows. An empty
 * `values` list runs no query at all (an empty `IN ()` is invalid in PostgreSQL).
 */
export async function selectInChunks<V, R>(
  values: readonly V[],
  query: (chunk: V[]) => Promise<readonly R[]>,
  size: number = IN_BATCH_VALUES,
): Promise<R[]> {
  const rows: R[] = [];
  for (const chunk of chunks([...new Set(values)], size)) rows.push(...(await query(chunk)));
  return rows;
}

/** Runs `insert` for each chunk of at most {@link INSERT_BATCH_ROWS} rows; nothing for an empty list. */
export async function insertInChunks<T>(
  rows: readonly T[],
  insert: (chunk: T[]) => Promise<unknown>,
  size: number = INSERT_BATCH_ROWS,
): Promise<void> {
  for (const chunk of chunks(rows, size)) await insert(chunk);
}

export type BatchLoopOptions = Readonly<{
  batchSize?: number;
  /** Upper bound on batches per call, so a job cannot run unbounded (default: no bound). */
  maxBatches?: number;
  /** Lets other work (HTTP requests) take the writer between batches; default: `setImmediate`. */
  yieldBetween?: () => Promise<void>;
}>;

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Repeats `deleteBatch(limit)` until it affects fewer than `limit` rows. `deleteBatch` must run its own short
 * `db.write` and delete at most `limit` rows, portably:
 * `DELETE FROM t WHERE (pk…) IN (SELECT pk… FROM t WHERE … LIMIT ?)` (PostgreSQL has no `DELETE … LIMIT`).
 * @returns the total number of deleted rows.
 */
export async function deleteInBatches(
  deleteBatch: (limit: number) => Promise<number>,
  options: BatchLoopOptions = {},
): Promise<number> {
  const limit = options.batchSize ?? DELETE_BATCH_ROWS;
  const maxBatches = options.maxBatches ?? Number.POSITIVE_INFINITY;
  const pause = options.yieldBetween ?? yieldToEventLoop;
  let total = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const deleted = await deleteBatch(limit);
    total += deleted;
    if (deleted < limit) break;
    await pause();
  }
  return total;
}
