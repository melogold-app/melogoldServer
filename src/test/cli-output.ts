/** A captured {@link CliOutput} for tests of the CLI: text of stdout and stderr, and the bytes of `outBytes`. */
import type { CliOutput } from "../cli/io.ts";

export type CapturedOutput = Readonly<{
  output: CliOutput;
  /** Everything written to stdout as text. */
  stdout(): string;
  stderr(): string;
  /** Everything written through `outBytes`. */
  bytes(): Buffer;
}>;

export function captureOutput(options: Readonly<{ isTty?: boolean }> = {}): CapturedOutput {
  const out: string[] = [];
  const err: string[] = [];
  const chunks: Buffer[] = [];
  return Object.freeze({
    output: Object.freeze({
      out: (text: string) => {
        out.push(text);
      },
      err: (text: string) => {
        err.push(text);
      },
      outBytes: (bytes: Uint8Array) => {
        chunks.push(Buffer.from(bytes));
        return Promise.resolve();
      },
      isTty: options.isTty ?? false,
    }),
    stdout: () => out.join(""),
    stderr: () => err.join(""),
    bytes: () => Buffer.concat(chunks),
  });
}
