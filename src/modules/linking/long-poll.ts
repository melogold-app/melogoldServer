/**
 * The long-poll of `POST /auth/link/poll` (API §4.6, DESIGN §4.10.6): waiters live in the memory of this process
 * (`Map<linkId, Set<wake>>`; DESIGN §11: one process serves the API).
 *
 * - A poll whose link still has the status the client already knows waits here, at most `waitSeconds` and never past
 *   the link's `expires_at`, then reads the link again.
 * - Every action on a link wakes its waiters **after commit** ({@link LinkWaiters.wake}): resolve, claim, approve,
 *   deny, cancel, completion.
 * - Shutdown (`preClose`, i.e. SIGTERM) wakes everybody ({@link LinkWaiters.close}): each poll answers with the status
 *   it reads then, and later waits return at once.
 * - A client that goes away aborts its wait through an `AbortSignal`.
 *
 * Changes made by another process (the CLI) or by another module (device removal cancels the links its device
 * approves) do not wake anybody: such a poll sees the new status when its wait ends.
 */

/** Why a wait ended. */
export type WaitOutcome = "woken" | "timeout" | "aborted" | "closed";

/** Timer functions (tests inject fakes). */
export type WaitTimers = Readonly<{
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}>;

const realTimers: WaitTimers = Object.freeze({
  setTimeout: (callback: () => void, ms: number) => {
    const handle = setTimeout(callback, ms);
    // A waiting poll must not keep a process alive that is otherwise done (tests, CLI).
    handle.unref();
    return handle;
  },
  clearTimeout: (handle: unknown) => {
    clearTimeout(handle as NodeJS.Timeout);
  },
});

type Waiter = (outcome: WaitOutcome) => void;

export class LinkWaiters {
  readonly #timers: WaitTimers;
  readonly #byLink = new Map<string, Set<Waiter>>();
  #closed = false;

  constructor(options: Readonly<{ timers?: WaitTimers }> = {}) {
    this.#timers = options.timers ?? realTimers;
  }

  /** `true` after {@link close}: waits end at once. */
  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Waits until the link is woken, `ms` milliseconds pass, `signal` aborts or the waiters are closed. Never rejects.
   */
  wait(linkId: string, ms: number, signal?: AbortSignal): Promise<WaitOutcome> {
    if (this.#closed) return Promise.resolve("closed");
    if (signal?.aborted === true) return Promise.resolve("aborted");
    if (!(ms > 0)) return Promise.resolve("timeout");
    return new Promise<WaitOutcome>((resolve) => {
      let set = this.#byLink.get(linkId);
      if (set === undefined) {
        set = new Set();
        this.#byLink.set(linkId, set);
      }
      const waiters = set;
      let timer: unknown = null;
      const onAbort = () => {
        finish("aborted");
      };
      const finish: Waiter = (outcome) => {
        if (!waiters.delete(finish)) return;
        if (waiters.size === 0 && this.#byLink.get(linkId) === waiters) this.#byLink.delete(linkId);
        if (timer !== null) this.#timers.clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      waiters.add(finish);
      timer = this.#timers.setTimeout(() => {
        finish("timeout");
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Wakes every waiter of the link; returns how many there were. */
  wake(linkId: string): number {
    const waiters = this.#byLink.get(linkId);
    if (waiters === undefined) return 0;
    const all = [...waiters];
    for (const finish of all) finish("woken");
    return all.length;
  }

  /** Wakes everybody and makes later waits return at once (shutdown). Idempotent. */
  close(): void {
    this.#closed = true;
    for (const waiters of [...this.#byLink.values()]) {
      for (const finish of [...waiters]) finish("closed");
    }
  }

  /** Number of waiting polls (of one link, or in total). */
  count(linkId?: string): number {
    if (linkId !== undefined) return this.#byLink.get(linkId)?.size ?? 0;
    let total = 0;
    for (const waiters of this.#byLink.values()) total += waiters.size;
    return total;
  }
}
