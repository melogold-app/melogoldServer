/**
 * A counting semaphore with a bounded FIFO queue (DESIGN §4.1: argon2 runs under `ARGON2_MAX_CONCURRENCY` permits
 * with a queue of `ARGON2_QUEUE_LIMIT`; overflow answers `503 server_busy` with `retryAfterSeconds: 5`).
 *
 * Waiting on a semaphore is never allowed inside a database transaction (docs/database.md §2.3).
 */

/** The queue is full: the caller answers `503 server_busy` (the HTTP error handler maps it with Retry-After 5). */
export class SemaphoreFullError extends Error {
  constructor(message = "semaphore queue is full") {
    super(message);
    this.name = "SemaphoreFullError";
  }
}

export type SemaphoreOptions = Readonly<{
  /** Permits held at the same time, >= 1. */
  concurrency: number;
  /** Callers allowed to wait for a permit, >= 0; the next one is rejected with {@link SemaphoreFullError}. */
  queueLimit: number;
}>;

/** Returns the permit. Calling it more than once has no effect. */
export type Release = () => void;

type Waiter = {
  resolve: (release: Release) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
};

export class Semaphore {
  readonly concurrency: number;
  readonly queueLimit: number;
  #active = 0;
  readonly #queue: Waiter[] = [];

  constructor(options: SemaphoreOptions) {
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
      throw new RangeError(`concurrency must be an integer >= 1, got ${options.concurrency}`);
    }
    if (!Number.isInteger(options.queueLimit) || options.queueLimit < 0) {
      throw new RangeError(`queueLimit must be an integer >= 0, got ${options.queueLimit}`);
    }
    this.concurrency = options.concurrency;
    this.queueLimit = options.queueLimit;
  }

  /** Permits in use. */
  get active(): number {
    return this.#active;
  }

  /** Callers waiting for a permit. */
  get queued(): number {
    return this.#queue.length;
  }

  /**
   * Takes a permit, waiting in FIFO order when none is free.
   * @throws SemaphoreFullError (as a rejection) when the queue is full.
   * @throws the signal's reason when `signal` aborts while waiting (the place in the queue is given up).
   */
  acquire(signal?: AbortSignal): Promise<Release> {
    if (signal?.aborted) return Promise.reject(signal.reason as Error);
    if (this.#active < this.concurrency) {
      this.#active += 1;
      return Promise.resolve(this.#releaser());
    }
    if (this.#queue.length >= this.queueLimit) return Promise.reject(new SemaphoreFullError());
    return new Promise<Release>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal, onAbort: undefined };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.#queue.indexOf(waiter);
          if (index !== -1) this.#queue.splice(index, 1);
          reject(signal.reason as Error);
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.#queue.push(waiter);
    });
  }

  /** Runs `fn` holding a permit and returns the permit afterwards, whatever `fn` does. */
  async run<T>(fn: () => Promise<T> | T, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  #releaser(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#handOver();
    };
  }

  /** Gives the freed permit to the first waiter, or returns it to the pool. */
  #handOver(): void {
    const next = this.#queue.shift();
    if (!next) {
      this.#active -= 1;
      return;
    }
    if (next.signal && next.onAbort) next.signal.removeEventListener("abort", next.onAbort);
    next.resolve(this.#releaser());
  }
}
