/**
 * A bounded set with least-recently-used eviction. The guard keeps the refresh ids it has already confirmed here
 * (DESIGN §4.3 step 5), so the `UPDATE refresh_tokens SET confirmed_at …` runs once per `rid` and process.
 */
export class LruSet<T> {
  readonly capacity: number;
  readonly #items = new Map<T, true>();

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError(`capacity must be >= 1, got ${capacity}`);
    this.capacity = capacity;
  }

  get size(): number {
    return this.#items.size;
  }

  /** Whether the value is present; a hit makes it the most recently used. */
  has(value: T): boolean {
    if (!this.#items.has(value)) return false;
    this.#items.delete(value);
    this.#items.set(value, true);
    return true;
  }

  /** Adds (or refreshes) the value, evicting the least recently used one when full. */
  add(value: T): this {
    this.#items.delete(value);
    this.#items.set(value, true);
    if (this.#items.size > this.capacity) {
      const oldest = this.#items.keys().next();
      if (!oldest.done) this.#items.delete(oldest.value);
    }
    return this;
  }

  delete(value: T): boolean {
    return this.#items.delete(value);
  }

  clear(): void {
    this.#items.clear();
  }
}
