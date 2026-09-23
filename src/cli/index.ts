/**
 * The command line of the image (`melogold <command>`, DESIGN §7.4, PLAN T3.1). It never imports Fastify: `main.ts`
 * loads it only for commands other than `serve`.
 *
 * M0: only `help` and `version`; every other command of PLAN T3.1 answers "not available yet" with exit code 64
 * (`EX_USAGE`). T3.1 owns this directory after M0.
 */
import { EnvError, loadEnv } from "../config/env.ts";

/** Exit codes: 0 ok, 1 failure, 64 usage error (sysexits.h `EX_USAGE`). */
export const EXIT_USAGE = 64;

/** Commands of PLAN T3.1 (for the help text). */
export const PLANNED_COMMANDS: readonly string[] = Object.freeze([
  "serve",
  "migrate",
  "info --json",
  "openapi",
  "check-config",
  "qr [url]",
  "user add|reset-password|delete|list [--usage]|devices|revoke-device",
  "backup --out <file|->",
  "restore --from <file|->",
  "verify-backup",
  "sync rotate-epoch --all|<login>",
  "secret rotate",
  "jobs run <name>",
  "verify-release",
]);

export type CliOutput = Readonly<{ out(text: string): void; err(text: string): void }>;

const stdio: CliOutput = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

function usage(): string {
  return `Usage: melogold <command>\n\nCommands:\n${PLANNED_COMMANDS.map((command) => `  ${command}`).join("\n")}\n  help\n  version\n`;
}

/** Runs one CLI command and returns the exit code. */
export function runCli(argv: readonly string[], output: CliOutput = stdio): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      output.out(usage());
      return Promise.resolve(0);
    case "version":
    case "--version": {
      try {
        const env = loadEnv();
        output.out(`melogold-server ${env.APP_VERSION} (${env.GIT_SHA})\n`);
        return Promise.resolve(0);
      } catch (error) {
        output.err(`${error instanceof EnvError ? error.message : String(error)}\n`);
        return Promise.resolve(1);
      }
    }
    default:
      output.err(`melogold: "${[command, ...rest].join(" ")}" is not available in this version\n\n${usage()}`);
      return Promise.resolve(EXIT_USAGE);
  }
}
