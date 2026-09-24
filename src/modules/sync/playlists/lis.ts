/**
 * Longest increasing subsequence for `playlist.items.replace` (DESIGN §3.7): the items of the new list that are
 * already present keep their order keys when they lie on an LIS of their current positions; only the others get new
 * keys. So a mirror of a YouTube playlist that moved one track rewrites one row, not the whole playlist.
 */

/**
 * Indices (ascending) of one longest **strictly** increasing subsequence of `values`, in O(n log n) (patience
 * sorting with predecessor links).
 *
 * When several subsequences have the maximal length, the one returned is deterministic: it ends at the element that
 * last reached the maximal length, and each earlier element is the predecessor recorded when that element was placed
 * (the smallest tail of the previous length at that moment). `spec/playlist-ops.vectors.json` pins the choice.
 */
export function longestIncreasingSubsequence(values: readonly number[]): number[] {
  /** `tails[k]`: index of the smallest last element of an increasing subsequence of length `k + 1`. */
  const tails: number[] = [];
  const previous = new Array<number>(values.length).fill(-1);
  for (let index = 0; index < values.length; index++) {
    const value = values[index] ?? 0;
    // The first tail whose value is >= value (strictly increasing: equal values never extend each other).
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((values[tails[middle] ?? 0] ?? 0) < value) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[index] = tails[low - 1] ?? -1;
    tails[low] = index;
  }
  const result: number[] = [];
  for (let index = tails.at(-1) ?? -1; index >= 0; index = previous[index] ?? -1) result.push(index);
  return result.reverse();
}
