/**
 * Passwords of the CLI (PLAN T3.1 "пароль берётся только с TTY"): typed on a terminal without echo, twice, or
 * generated (`--generate-password`, the installer with `--yes`, DESIGN §7.3 step 11). Never from an argument, an
 * environment variable or a pipe: those end up in shell histories, `ps` and logs.
 */
import { randomInt } from "node:crypto";
import { CliError } from "./io.ts";
import type { CliOutput } from "./io.ts";

/** Where the CLI reads what the person types: the terminal, or a script in tests. */
export type Prompter = Readonly<{
  /** Reads one line without echo (a password). */
  hidden(prompt: string): Promise<string>;
  /** Reads one visible line (a confirmation). */
  visible(prompt: string): Promise<string>;
}>;

/** Letters and digits that cannot be confused with each other when read aloud or copied by hand. */
const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const GROUPS = 4;
const GROUP_LENGTH = 5;

/** A random password of 4 groups of 5 characters (`k7Qp2-mXzRt-9wLb4-nH3ce`), about 115 bits. */
export function generatePassword(): string {
  const groups: string[] = [];
  for (let group = 0; group < GROUPS; group++) {
    let text = "";
    for (let index = 0; index < GROUP_LENGTH; index++) text += ALPHABET.charAt(randomInt(ALPHABET.length));
    groups.push(text);
  }
  return groups.join("-");
}

/** `value` without its last code point (a surrogate pair is one character). */
function dropLastCharacter(value: string): string {
  const last = value.length - 1;
  const code = value.charCodeAt(last);
  const pair = code >= 0xdc00 && code <= 0xdfff && last > 0;
  return value.slice(0, pair ? last - 1 : last);
}

function characterCount(value: string): number {
  let count = 0;
  for (const _char of value) count += 1;
  return count;
}

/**
 * The prompter of the process: `/dev/tty`-like stdin in raw mode, the prompt on stderr.
 * @throws CliError when stdin is not a terminal.
 */
export function terminalPrompter(output: Pick<CliOutput, "err">, stdin: NodeJS.ReadStream = process.stdin): Prompter {
  const requireTty = () => {
    if (!stdin.isTTY) {
      throw new CliError(
        "a password is read only from a terminal: run the command with one (docker compose exec, docker run -it) " +
          "or add --generate-password",
      );
    }
  };
  const readLine = (prompt: string, echo: boolean) =>
    new Promise<string>((resolve, reject) => {
      requireTty();
      output.err(prompt);
      let value = "";
      const cleanup = () => {
        stdin.off("data", onData);
        stdin.setRawMode(false);
        stdin.pause();
      };
      const onData = (chunk: Buffer | string) => {
        for (const char of String(chunk)) {
          if (char === "\r" || char === "\n") {
            cleanup();
            output.err("\n");
            resolve(value);
            return;
          }
          if (char === "\u0003" || char === "\u0004") {
            cleanup();
            output.err("\n");
            reject(new CliError("cancelled"));
            return;
          }
          if (char === "\u007f" || char === "\b") {
            if (value.length > 0) {
              value = dropLastCharacter(value);
              if (echo) output.err("\b \b");
            }
            continue;
          }
          if (char === "\u0015") {
            if (echo) output.err("\b \b".repeat(characterCount(value)));
            value = "";
            continue;
          }
          if (char < " ") continue;
          value += char;
          if (echo) output.err(char);
        }
      };
      stdin.setRawMode(true);
      stdin.setEncoding("utf8");
      stdin.on("data", onData);
      stdin.resume();
    });
  return Object.freeze({
    hidden: (prompt: string) => readLine(prompt, false),
    visible: (prompt: string) => readLine(prompt, true),
  });
}

/** Asks for a new password twice; they must match. */
export async function askNewPassword(prompter: Prompter, login: string): Promise<string> {
  const password = await prompter.hidden(`New password for ${login}: `);
  const again = await prompter.hidden("Repeat the password: ");
  if (password !== again) throw new CliError("the passwords differ");
  return password;
}
