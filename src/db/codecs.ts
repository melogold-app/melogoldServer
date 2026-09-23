/**
 * Value codecs between TypeScript and the portable column types (API §9.1).
 *
 * - `JSON` columns hold JSON text; SQL never looks inside. {@link jsonCodec} validates what it reads with zod, so a
 *   corrupted or outdated document fails loudly instead of leaking into responses.
 * - `BOOL` columns hold `0 | 1` in both dialects ({@link toDbBool}, {@link fromDbBool}).
 * - PostgreSQL `bigint` (int8, OID 20) arrives as text; {@link safeInt} turns it into a number and throws when the
 *   value is outside ±(2^53 − 1), so a precision loss never goes unnoticed. `numeric` (OID 1700: `sum()` over
 *   `bigint`) is parsed by {@link safeIntegerNumeric} with the same guarantee.
 */
import type { z } from "zod";

export class CodecError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodecError";
  }
}

export type JsonCodec<T> = Readonly<{
  /** Serializes a value for a `JSON` column. The value is validated first: invalid data is never written. */
  encode(value: T): string;
  /** Parses and validates the text of a `JSON` column. */
  decode(text: string): T;
  encodeNullable(value: T | null): string | null;
  decodeNullable(text: string | null): T | null;
}>;

/**
 * Codec for a `JSON` column whose document is described by a zod schema. The schema should describe the stored
 * shape (the output type is what the application works with).
 */
export function jsonCodec<S extends z.ZodType>(schema: S, name = "JSON column"): JsonCodec<z.output<S>> {
  const validate = (value: unknown, action: "encode" | "decode"): z.output<S> => {
    const result = schema.safeParse(value);
    if (!result.success) {
      const issues = result.error.issues.map((issue) => `${issue.path.map(String).join(".")}: ${issue.code}`);
      throw new CodecError(`${name}: cannot ${action} an invalid document (${issues.join("; ")})`);
    }
    return result.data;
  };

  const encode = (value: z.output<S>): string => JSON.stringify(validate(value, "encode"));
  const decode = (text: string): z.output<S> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new CodecError(`${name}: stored text is not JSON`, { cause: error });
    }
    return validate(parsed, "decode");
  };

  return Object.freeze({
    encode,
    decode,
    encodeNullable: (value: z.output<S> | null) => (value === null ? null : encode(value)),
    decodeNullable: (text: string | null) => (text === null ? null : decode(text)),
  });
}

export type DbBool = 0 | 1;

export function toDbBool(value: boolean): DbBool {
  return value ? 1 : 0;
}

export function fromDbBool(value: number): boolean {
  if (value === 1) return true;
  if (value === 0) return false;
  throw new CodecError(`BOOL column holds ${value}, expected 0 or 1`);
}

const INTEGER_TEXT = /^-?\d{1,20}$/;

/** `pg` type parser for `bigint` (int8): a number, or an error when it would lose precision. */
export function safeInt(text: string): number {
  const value = Number(text);
  if (!INTEGER_TEXT.test(text) || !Number.isSafeInteger(value)) {
    throw new CodecError(`bigint value ${text} is outside the safe integer range (±(2^53 − 1))`);
  }
  return value;
}

/** `pg` type parser for `numeric`: accepted only when it is an integer within the safe range. */
export function safeIntegerNumeric(text: string): number {
  const integer = /^(-?\d+)(?:\.0+)?$/.exec(text);
  if (!integer?.[1]) throw new CodecError(`numeric value ${text} is not an integer (the API has no fractions)`);
  return safeInt(integer[1]);
}
