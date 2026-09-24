/**
 * Proof of work for registration (API §4.3, DESIGN §4.2 M9). Vectors for clients: `spec/pow.vectors.json`.
 *
 * **Challenge** (`GET /auth/register/challenge`): `mgpow1.<b64url(JSON{n, b, exp})>.<b64url(HMAC)>` signed with the
 * HKDF subkey `melogold/pow/v1`; `n` is a random id, `b` the required leading zero bits, `exp` the expiry (epoch ms,
 * TTL 10 minutes). The server keeps no state for an issued challenge.
 *
 * **Solution:** the first `nonce` of "0", "1", "2", … (decimal, no leading zeros) such that
 * `sha256(UTF-8(challenge + ":" + nonce))` starts with at least `b` zero bits.
 *
 * **Check** (`POST /auth/register`, after the registration mode and before the schema): while proof of work is
 * required, a request without `pow` is `403 pow_required`; a solution whose challenge is forged, expired, already
 * used, easier than what is required now, or whose hash lacks the zero bits is `403 pow_invalid`. A valid solution is
 * used up at once (one use per challenge, remembered in memory until the challenge expires), so a retry after any
 * later refusal needs a new challenge.
 *
 * **Difficulty** ({@link powDifficulty}): `REGISTRATION_POW_BITS` (0 = off), raised when the registrations of the last
 * hour exceed `REGISTRATION_POW_SOFT_PER_HOUR`: +4 bits above the threshold, +8 above twice the threshold; with a
 * base of 0 this switches proof of work on at 16 (then 20) bits. Never above {@link POW_MAX_BITS}. No global 429:
 * one attacker cannot close registration for everybody. The registrations are counted in process memory, like the
 * rate limits (DESIGN §11: one process).
 */
import { HOUR_MS, MINUTE_MS } from "../../lib/clock.ts";
import { randomBase64Url, sha256 } from "../../lib/crypto.ts";
import { formatIso } from "../../lib/time.ts";
import { POW_CHALLENGE_MAX_LENGTH, POW_CHALLENGE_PREFIX, openCompact, signCompact } from "../../lib/tokens.ts";

/** API §4.3: a challenge lives 10 minutes. */
export const POW_CHALLENGE_TTL_MS = 10 * MINUTE_MS;
/** The upper bound of `REGISTRATION_POW_BITS` (API §10), also the cap of the adaptive difficulty. */
export const POW_MAX_BITS = 26;
/** DESIGN §4.2: with a base of 0 the adaptive proof of work starts at 16 bits. */
export const POW_ADAPTIVE_START_BITS = 16;
/** Bits added above the threshold / above twice the threshold. */
export const POW_ADAPTIVE_STEP_BITS = 4;
export const POW_NONCE_PATTERN = /^[0-9]{1,16}$/;

const CHALLENGE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** Leading zero bits of a digest. */
export function leadingZeroBits(digest: Uint8Array): number {
  let bits = 0;
  for (const byte of digest) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

/** `sha256(UTF-8(challenge + ":" + nonce))`. */
export function powDigest(challenge: string, nonce: string): Buffer {
  return sha256(`${challenge}:${nonce}`);
}

/** Whether `nonce` solves `challenge` at `bits`. */
export function meetsDifficulty(challenge: string, nonce: string, bits: number): boolean {
  return leadingZeroBits(powDigest(challenge, nonce)) >= bits;
}

/**
 * The client's loop: the first nonce "0", "1", … that solves the challenge (tests, vectors, smoke clients).
 * @throws RangeError after `maxAttempts` nonces.
 */
export function solvePow(challenge: string, bits: number, maxAttempts = 2 ** 32): string {
  for (let nonce = 0; nonce < maxAttempts; nonce++) {
    const text = String(nonce);
    if (meetsDifficulty(challenge, text, bits)) return text;
  }
  throw new RangeError(`no nonce below ${maxAttempts} solves the challenge at ${bits} bits`);
}

export type PowDifficultyInput = Readonly<{
  /** `REGISTRATION_POW_BITS`. */
  baseBits: number;
  /** `REGISTRATION_POW_SOFT_PER_HOUR`. */
  softPerHour: number;
  /** Registrations in the last hour. */
  registrationsLastHour: number;
}>;

/** The bits required now (0: proof of work is off). */
export function powDifficulty(input: PowDifficultyInput): number {
  const { baseBits, softPerHour, registrationsLastHour } = input;
  const extra =
    registrationsLastHour > 2 * softPerHour
      ? 2 * POW_ADAPTIVE_STEP_BITS
      : registrationsLastHour > softPerHour
        ? POW_ADAPTIVE_STEP_BITS
        : 0;
  if (extra === 0) return Math.min(baseBits, POW_MAX_BITS);
  const base = baseBits > 0 ? baseBits : POW_ADAPTIVE_START_BITS - POW_ADAPTIVE_STEP_BITS;
  return Math.min(base + extra, POW_MAX_BITS);
}

/** Registrations of the last hour, in memory. */
export class RegistrationWindow {
  readonly #times: number[] = [];
  readonly #windowMs: number;

  constructor(windowMs: number = HOUR_MS) {
    this.#windowMs = windowMs;
  }

  record(now: number): void {
    this.#times.push(now);
  }

  count(now: number): number {
    const from = now - this.#windowMs;
    let expired = 0;
    while (expired < this.#times.length && (this.#times[expired] ?? 0) <= from) expired += 1;
    if (expired > 0) this.#times.splice(0, expired);
    return this.#times.filter((time) => time <= now).length;
  }
}

/** The payload of a challenge. */
export type PowChallengePayload = Readonly<{ n: string; b: number; exp: number }>;

/** API §4.3 `RegisterChallenge`. */
export type IssuedChallenge = Readonly<{ challenge: string; bits: number; expiresAt: string }>;

/** API §4.3 `PowSolution` as it arrives, before the schema. */
export type PowSolutionInput = Readonly<{ challenge: string; nonce: string }>;

/**
 * Reads `pow` of a raw register body (the check runs before the schema).
 * @returns the solution, `null` when `pow` is absent or `null`, `"malformed"` for anything else.
 */
export function readPowSolution(body: unknown): PowSolutionInput | null | "malformed" {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const pow: unknown = (body as Record<string, unknown>).pow;
  if (pow === undefined || pow === null) return null;
  if (typeof pow !== "object" || Array.isArray(pow)) return "malformed";
  const { challenge, nonce } = pow as Record<string, unknown>;
  if (typeof challenge !== "string" || typeof nonce !== "string") return "malformed";
  if (challenge.length > POW_CHALLENGE_MAX_LENGTH || !POW_NONCE_PATTERN.test(nonce)) return "malformed";
  return { challenge, nonce };
}

function isPayload(value: unknown): value is PowChallengePayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const { n, b, exp } = value as Record<string, unknown>;
  return (
    typeof n === "string" &&
    CHALLENGE_ID_PATTERN.test(n) &&
    typeof b === "number" &&
    Number.isInteger(b) &&
    b >= 0 &&
    b <= 256 &&
    typeof exp === "number" &&
    Number.isSafeInteger(exp) &&
    exp > 0
  );
}

export type PowCheck = "ok" | "required" | "invalid";

export type PowGateOptions = Readonly<{
  /** HKDF subkey `melogold/pow/v1`. */
  key: Uint8Array;
  /** `REGISTRATION_POW_BITS`. */
  baseBits: number;
  /** `REGISTRATION_POW_SOFT_PER_HOUR`. */
  softPerHour: number;
}>;

/** Proof-of-work state of one application: issued difficulty, used challenges, recent registrations. */
export class PowGate {
  readonly #key: Uint8Array;
  readonly #baseBits: number;
  readonly #softPerHour: number;
  readonly #registrations = new RegistrationWindow();
  /** Used challenge ids → their expiry; insertion order is expiry order (constant TTL). */
  readonly #used = new Map<string, number>();

  constructor(options: PowGateOptions) {
    this.#key = options.key;
    this.#baseBits = options.baseBits;
    this.#softPerHour = options.softPerHour;
  }

  /** The bits a registration needs now (0: proof of work is off). */
  requiredBits(now: number): number {
    return powDifficulty({
      baseBits: this.#baseBits,
      softPerHour: this.#softPerHour,
      registrationsLastHour: this.#registrations.count(now),
    });
  }

  /** `GET /auth/register/challenge`: a challenge at the current difficulty. */
  issue(now: number): IssuedChallenge {
    const bits = this.requiredBits(now);
    const exp = now + POW_CHALLENGE_TTL_MS;
    const payload: PowChallengePayload = { n: randomBase64Url(12), b: bits, exp };
    return Object.freeze({
      challenge: signCompact(POW_CHALLENGE_PREFIX, payload, this.#key),
      bits,
      expiresAt: formatIso(exp),
    });
  }

  /**
   * Checks and uses up a solution (see the module comment).
   * @param solution what {@link readPowSolution} read from the body.
   */
  check(solution: PowSolutionInput | null | "malformed", now: number): PowCheck {
    const required = this.requiredBits(now);
    if (required === 0) return "ok";
    if (solution === null) return "required";
    if (solution === "malformed") return "invalid";
    const payload = openCompact(POW_CHALLENGE_PREFIX, solution.challenge, this.#key, POW_CHALLENGE_MAX_LENGTH);
    if (!isPayload(payload) || payload.exp <= now || payload.b < required) return "invalid";
    this.#forgetExpired(now);
    if (this.#used.has(payload.n)) return "invalid";
    if (!meetsDifficulty(solution.challenge, solution.nonce, payload.b)) return "invalid";
    this.#used.set(payload.n, payload.exp);
    return "ok";
  }

  /** Counts a successful registration for the adaptive difficulty. */
  recordRegistration(now: number): void {
    this.#registrations.record(now);
  }

  #forgetExpired(now: number): void {
    for (const [id, exp] of this.#used) {
      if (exp > now) break;
      this.#used.delete(id);
    }
  }
}
