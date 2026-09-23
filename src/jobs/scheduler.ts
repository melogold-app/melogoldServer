/**
 * Background job scheduler (API §5 "Фоновые задачи", DESIGN §2): one process, timers in memory.
 *
 * - A job has one or more schedules: `every` (a fixed interval, e.g. `auth-cleanup` hourly, `account-purge` every
 *   15 min, `disk-guard` every minute) or `daily` (a UTC time of day with a random jitter, e.g. `retention` at
 *   `RETENTION_RUN_AT_UTC` ± 10 min). `sqlite-maintenance` uses both ("каждые 6 ч и ежедневно").
 * - A job never overlaps itself: a run that is due while the previous one is still running is skipped.
 * - A failing run is logged and the job stays scheduled.
 * - {@link Scheduler.stop} clears the timers, aborts the `signal` of running jobs and waits for them (server
 *   shutdown); {@link Scheduler.runNow} runs one job immediately (`melogold jobs run <name>`, tests).
 *
 * Jobs publish no SSE events and never move `seq` (API §5). The jobs themselves are registered in `src/jobs/index.ts`.
 */
import { DAY_MS } from "../lib/clock.ts";
import type { Clock } from "../lib/clock.ts";

/** A UTC time of day (the shape of `Env.RETENTION_RUN_AT_UTC`). */
export type UtcTime = Readonly<{ hour: number; minute: number }>;

export type JobSchedule =
  Readonly<{ every: number; firstDelayMs?: number }> | Readonly<{ dailyAt: UtcTime; jitterMs?: number }>;

export type JobLogger = Readonly<{
  info(details: object, message: string): void;
  warn(details: object, message: string): void;
  error(details: object, message: string): void;
}>;

export type JobRunContext = Readonly<{
  name: string;
  /** Aborted when the server stops: long jobs stop between batches. */
  signal: AbortSignal;
  /** Start of this run, epoch ms (`ctx.clock`). */
  startedAt: number;
  log: JobLogger;
}>;

export type JobDefinition = Readonly<{
  /** kebab-case, unique: `retention`, `auth-cleanup`, `account-purge`, `sqlite-maintenance`, `disk-guard`, … */
  name: string;
  schedules: readonly JobSchedule[];
  run(job: JobRunContext): Promise<void>;
}>;

export type JobRunResult = "done" | "failed" | "skipped_running" | "stopped";

export type JobStatus = Readonly<{
  name: string;
  running: boolean;
  nextRunAt: number | null;
  lastStartedAt: number | null;
  lastFinishedAt: number | null;
  lastError: string | null;
}>;

/** Timer functions (tests inject fakes). */
export type SchedulerTimers = Readonly<{
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}>;

export type SchedulerOptions = Readonly<{
  clock: Clock;
  log: JobLogger;
  /** Uniform [0, 1) for the daily jitter (default `Math.random`). */
  random?: () => number;
  timers?: SchedulerTimers;
}>;

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Node timers overflow above 2^31 − 1 ms; longer waits are re-armed. */
const MAX_TIMER_MS = 2_147_483_647;

const realTimers: SchedulerTimers = Object.freeze({
  setTimeout: (callback: () => void, ms: number) => {
    const handle = setTimeout(callback, ms);
    handle.unref();
    return handle;
  },
  clearTimeout: (handle: unknown) => {
    clearTimeout(handle as NodeJS.Timeout);
  },
});

export class SchedulerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchedulerError";
  }
}

function checkSchedule(name: string, schedule: JobSchedule): void {
  if ("every" in schedule) {
    if (!Number.isSafeInteger(schedule.every) || schedule.every < 1000) {
      throw new SchedulerError(`${name}: "every" must be at least 1000 ms`);
    }
    const first = schedule.firstDelayMs;
    if (first !== undefined && (!Number.isSafeInteger(first) || first < 0)) {
      throw new SchedulerError(`${name}: "firstDelayMs" must be a non-negative integer`);
    }
    return;
  }
  const { hour, minute } = schedule.dailyAt;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new SchedulerError(`${name}: invalid daily time`);
  }
  const jitter = schedule.jitterMs ?? 0;
  if (!Number.isSafeInteger(jitter) || jitter < 0 || jitter >= DAY_MS / 2) {
    throw new SchedulerError(`${name}: "jitterMs" must be in [0, 12 h)`);
  }
}

/**
 * The next run of one schedule strictly after `now`.
 * - `every`: `previous + every`, or `now + firstDelayMs` (default `every`) for the first run;
 * - `dailyAt`: the next `HH:MM` UTC plus a uniform offset in `[-jitterMs, +jitterMs]`, always after `now`.
 */
export function nextRunAt(
  schedule: JobSchedule,
  now: number,
  previous: number | null,
  random: () => number = Math.random,
): number {
  if ("every" in schedule) {
    if (previous === null) return now + (schedule.firstDelayMs ?? schedule.every);
    return Math.max(previous + schedule.every, now + 1);
  }
  const jitter = schedule.jitterMs ?? 0;
  const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
  const timeOfDay = (schedule.dailyAt.hour * 60 + schedule.dailyAt.minute) * 60_000;
  const offset = jitter === 0 ? 0 : Math.round((random() * 2 - 1) * jitter);
  for (let day = 0; day < 3; day += 1) {
    const candidate = dayStart + day * DAY_MS + timeOfDay + offset;
    if (candidate > now && (previous === null || candidate - previous > jitter * 2)) return candidate;
  }
  return dayStart + 2 * DAY_MS + timeOfDay;
}

type JobState = {
  definition: JobDefinition;
  /** Previous planned time of each schedule (null before the first run). */
  previous: (number | null)[];
  planned: number[];
  nextRunAt: number | null;
  timer: unknown;
  running: Promise<JobRunResult> | null;
  lastStartedAt: number | null;
  lastFinishedAt: number | null;
  lastError: string | null;
};

export class Scheduler {
  readonly #clock: Clock;
  readonly #log: JobLogger;
  readonly #random: () => number;
  readonly #timers: SchedulerTimers;
  readonly #jobs = new Map<string, JobState>();
  readonly #abort = new AbortController();
  #started = false;
  #stopped = false;

  constructor(options: SchedulerOptions) {
    this.#clock = options.clock;
    this.#log = options.log;
    this.#random = options.random ?? Math.random;
    this.#timers = options.timers ?? realTimers;
  }

  /** Registers a job (before or after {@link start}). */
  add(definition: JobDefinition): void {
    if (!NAME_PATTERN.test(definition.name)) throw new SchedulerError(`invalid job name "${definition.name}"`);
    if (this.#jobs.has(definition.name)) throw new SchedulerError(`job "${definition.name}" is registered twice`);
    if (definition.schedules.length === 0) throw new SchedulerError(`job "${definition.name}" has no schedule`);
    for (const schedule of definition.schedules) checkSchedule(definition.name, schedule);
    const state: JobState = {
      definition,
      previous: definition.schedules.map(() => null),
      planned: [],
      nextRunAt: null,
      timer: null,
      running: null,
      lastStartedAt: null,
      lastFinishedAt: null,
      lastError: null,
    };
    this.#jobs.set(definition.name, state);
    if (this.#started && !this.#stopped) this.#arm(state);
  }

  names(): string[] {
    return [...this.#jobs.keys()];
  }

  /** Arms the timers of every job. */
  start(): void {
    if (this.#stopped) throw new SchedulerError("the scheduler was stopped");
    if (this.#started) return;
    this.#started = true;
    for (const state of this.#jobs.values()) this.#arm(state);
  }

  /** Runs a job now, outside its schedule. A job that is already running is not started twice. */
  runNow(name: string): Promise<JobRunResult> {
    const state = this.#jobs.get(name);
    if (!state) return Promise.reject(new SchedulerError(`unknown job "${name}"`));
    return this.#run(state);
  }

  status(): JobStatus[] {
    return [...this.#jobs.values()].map((state) => ({
      name: state.definition.name,
      running: state.running !== null,
      nextRunAt: state.nextRunAt,
      lastStartedAt: state.lastStartedAt,
      lastFinishedAt: state.lastFinishedAt,
      lastError: state.lastError,
    }));
  }

  /** Clears the timers, aborts running jobs and waits until they return. Idempotent. */
  async stop(): Promise<void> {
    this.#stopped = true;
    for (const state of this.#jobs.values()) {
      this.#timers.clearTimeout(state.timer);
      state.timer = null;
      state.nextRunAt = null;
    }
    this.#abort.abort();
    await Promise.all([...this.#jobs.values()].flatMap((state) => (state.running ? [state.running] : [])));
  }

  /** Plans every schedule that has no future time yet and waits for the earliest one. */
  #arm(state: JobState): void {
    const now = this.#clock.now();
    state.planned = state.definition.schedules.map((schedule, index) => {
      const planned = state.planned[index];
      return planned !== undefined && planned > now
        ? planned
        : nextRunAt(schedule, now, state.previous[index] ?? null, this.#random);
    });
    const next = Math.min(...state.planned);
    state.nextRunAt = next;
    this.#wait(state, next);
  }

  #wait(state: JobState, at: number): void {
    const delay = Math.max(0, at - this.#clock.now());
    state.timer = this.#timers.setTimeout(
      () => {
        if (this.#stopped) return;
        if (this.#clock.now() < at) {
          this.#wait(state, at);
          return;
        }
        this.#due(state, at);
      },
      Math.min(delay, MAX_TIMER_MS),
    );
  }

  /** The earliest planned time arrived: re-plan the schedules that fired, start the run (unless one is running). */
  #due(state: JobState, at: number): void {
    state.planned.forEach((planned, index) => {
      if (planned <= at) state.previous[index] = planned;
    });
    this.#arm(state);
    void this.#run(state);
  }

  #run(state: JobState): Promise<JobRunResult> {
    const name = state.definition.name;
    if (this.#stopped) return Promise.resolve("stopped");
    if (state.running) {
      this.#log.warn({ job: name }, "job is still running; this run is skipped");
      return Promise.resolve("skipped_running");
    }
    const startedAt = this.#clock.now();
    state.lastStartedAt = startedAt;
    const run = (async (): Promise<JobRunResult> => {
      try {
        await state.definition.run({ name, signal: this.#abort.signal, startedAt, log: this.#log });
        state.lastError = null;
        return "done";
      } catch (error) {
        state.lastError = error instanceof Error ? error.message : String(error);
        this.#log.error({ err: error, job: name }, "job failed");
        return "failed";
      } finally {
        state.lastFinishedAt = this.#clock.now();
        state.running = null;
      }
    })();
    state.running = run;
    return run;
  }
}
