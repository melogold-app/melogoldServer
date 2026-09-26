/**
 * Input and output of the CLI (DESIGN §7.4, PLAN T3.1): results go to stdout, messages and logs to stderr, so
 * `melogold backup --out -` and `melogold info --json` can be piped. Exit codes: 0 ok, 1 failure, 64 usage error
 * (sysexits.h `EX_USAGE`).
 */
import type { AppLogger } from "../context.ts";

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 64;

export type CliOutput = Readonly<{
  out(text: string): void;
  err(text: string): void;
  /** Binary output (`backup --out -`). */
  outBytes(bytes: Uint8Array): Promise<void>;
  /** Whether stdout is a terminal (colors of `qr`). */
  isTty: boolean;
}>;

export const stdio: CliOutput = Object.freeze({
  out: (text: string) => {
    process.stdout.write(text);
  },
  err: (text: string) => {
    process.stderr.write(text);
  },
  outBytes: (bytes: Uint8Array) =>
    new Promise<void>((resolve, reject) => {
      process.stdout.write(bytes, (error) => {
        if (error) reject(error);
        else resolve();
      });
    }),
  isTty: process.stdout.isTTY,
});

/** A wrong command line: the message goes to stderr with the usage, exit code 64. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** A failure the command explains itself: the message goes to stderr, exit code 1. */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

/**
 * The CLI's logger: warnings and errors (from the database layer, the jobs) as `melogold: <level>: <message>` lines
 * on stderr; `info` only with `verbose`.
 */
export function stderrLogger(output: Pick<CliOutput, "err">, verbose = false): AppLogger {
  const line = (level: string) => (details: object, message: string) => {
    const extra = Object.keys(details).length > 0 ? ` ${JSON.stringify(details, errorReplacer)}` : "";
    output.err(`melogold: ${level}: ${message}${extra}\n`);
  };
  const ignore = (): undefined => undefined;
  return Object.freeze({
    trace: ignore,
    debug: ignore,
    info: verbose ? line("info") : ignore,
    warn: line("warn"),
    error: line("error"),
    fatal: line("fatal"),
  });
}

function errorReplacer(_key: string, value: unknown): unknown {
  return value instanceof Error ? { name: value.name, message: value.message } : value;
}
