/**
 * The application clock (`ctx.clock`). All server time is epoch milliseconds UTC (API §1.5); SQL never reads the
 * time itself (`now()` is forbidden, docs/database.md §4.2), so every timestamp comes from here and tests control it
 * with {@link ManualClock}.
 */

export type Clock = Readonly<{
  /** Current time, epoch milliseconds UTC (an integer). */
  now(): number;
}>;

/** The real clock. */
export const systemClock: Clock = Object.freeze({ now: () => Date.now() });

/** A clock that moves only when told to (tests, deterministic jobs). */
export class ManualClock implements Clock {
  #now: number;

  constructor(start: number) {
    this.#now = checkTime(start);
  }

  now(): number {
    return this.#now;
  }

  /** Jumps to `time` (epoch milliseconds); going back is allowed, tests need it for skew scenarios. */
  set(time: number): void {
    this.#now = checkTime(time);
  }

  /** Moves forward (or back, with a negative value) by `ms` milliseconds and returns the new time. */
  advance(ms: number): number {
    this.#now = checkTime(this.#now + ms);
    return this.#now;
  }
}

function checkTime(value: number): number {
  if (!Number.isSafeInteger(value)) throw new RangeError(`clock time must be a safe integer, got ${value}`);
  return value;
}

export const SECOND_MS = 1000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
