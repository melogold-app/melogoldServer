/**
 * The command line of the image (`melogold <command>`, DESIGN §7.4, PLAN T3.1). It never imports Fastify: `main.ts`
 * loads it only for commands other than `serve`, and the commands are loaded lazily, so `version` and `help` open
 * nothing.
 *
 * Results go to stdout, messages to stderr. Exit codes: 0 ok, 1 failure, 64 usage error (`EX_USAGE`). A password is
 * read only from a terminal (PLAN T3.1 "пароль берётся только с TTY"), or generated with `--generate-password`.
 */
import { parseArgs } from "node:util";
import type { ParseArgsConfig } from "node:util";
import { EnvError, loadEnv } from "../config/env.ts";
import type { Env } from "../config/env.ts";
import { CliError, EXIT_FAILURE, EXIT_OK, EXIT_USAGE, UsageError, stderrLogger, stdio } from "./io.ts";
import type { CliOutput } from "./io.ts";
import type { OpenRuntimeOptions } from "./runtime.ts";

export { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from "./io.ts";
export type { CliOutput } from "./io.ts";

/** The commands, as `help` lists them. */
export const COMMANDS: readonly string[] = Object.freeze([
  "serve",
  "migrate",
  "info [--json]",
  "check-config",
  "openapi [--yaml]",
  "qr [url] [--color|--plain]",
  "user add <login> [--generate-password]",
  "user reset-password <login> [--generate-password]",
  "user delete <login> --yes",
  "user list [--usage] [--json]",
  "user devices <login> [--json]",
  "user revoke-device <login> <device-id>",
  "backup --out <file|->",
  "restore --from <file|-> [--yes]",
  "verify-backup --from <file|->",
  "sync rotate-epoch --all|<login>",
  "secret rotate",
  "jobs run <name>",
  "verify-release <SHA256SUMS> <SHA256SUMS.minisig>",
  "version",
  "help",
]);

function usage(): string {
  return (
    `Usage: melogold <command> [--verbose]\n\nCommands:\n${COMMANDS.map((command) => `  ${command}`).join("\n")}\n\n` +
    "Results go to stdout, messages to stderr. See docs/self-hosting.md.\n"
  );
}

type Options = NonNullable<ParseArgsConfig["options"]>;

/** Parses the arguments after the command words; unknown flags are usage errors. */
function parse(args: readonly string[], options: Options, maxPositionals: number) {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      options: { ...options, verbose: { type: "boolean" } },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  if (parsed.positionals.length > maxPositionals) {
    throw new UsageError(`unexpected argument "${parsed.positionals[maxPositionals] ?? ""}"`);
  }
  const values = parsed.values as Record<string, string | boolean | undefined>;
  const flag = (name: string) => values[name] === true;
  const value = (name: string) => {
    const found = values[name];
    return typeof found === "string" ? found : undefined;
  };
  return { positionals: parsed.positionals, flag, value };
}

function required(value: string | undefined, what: string): string {
  if (value === undefined || value === "") throw new UsageError(`missing ${what}`);
  return value;
}

type Run = (env: Env, output: CliOutput, runtime: OpenRuntimeOptions) => Promise<number>;

/** Resolves the command words to a runner; throws `UsageError` for anything unknown. */
function resolve(argv: readonly string[]): Readonly<{ run: Run; verbose: boolean }> {
  const [command, sub, ...rest] = argv;
  const words = (count: number) => argv.slice(count);
  const plain = (args: readonly string[], options: Options, maxPositionals: number) =>
    parse(args, options, maxPositionals);

  switch (command) {
    case "migrate": {
      const args = plain(words(1), {}, 0);
      return {
        verbose: args.flag("verbose"),
        run: async (env, output, runtime) => (await import("./basic.ts")).migrateCommand(env, output, runtime),
      };
    }
    case "info": {
      const args = plain(words(1), { json: { type: "boolean" } }, 0);
      return {
        verbose: args.flag("verbose"),
        run: async (env, output, runtime) =>
          (await import("./basic.ts")).infoCommand(env, output, runtime, args.flag("json")),
      };
    }
    case "check-config": {
      const args = plain(words(1), {}, 0);
      return {
        verbose: args.flag("verbose"),
        run: async (env, output, runtime) => (await import("./basic.ts")).checkConfigCommand(env, output, runtime),
      };
    }
    case "openapi": {
      const args = plain(words(1), { yaml: { type: "boolean" } }, 0);
      return {
        verbose: false,
        run: async (_env, output) => (await import("./basic.ts")).openapiCommand(output, args.flag("yaml")),
      };
    }
    case "qr": {
      const args = plain(words(1), { color: { type: "boolean" }, plain: { type: "boolean" } }, 1);
      if (args.flag("color") && args.flag("plain")) throw new UsageError("--color and --plain exclude each other");
      return {
        verbose: false,
        run: async (env, output) =>
          (await import("./basic.ts")).qrCommand(
            env,
            output,
            args.positionals[0],
            args.flag("color") || (output.isTty && !args.flag("plain")),
          ),
      };
    }
    case "jobs": {
      if (sub !== "run") throw new UsageError("usage: melogold jobs run <name>");
      const args = plain(rest, {}, 1);
      const name = required(args.positionals[0], "job name");
      return {
        verbose: args.flag("verbose"),
        run: async (env, output, runtime) => (await import("./basic.ts")).jobsRunCommand(env, output, runtime, name),
      };
    }
    case "secret": {
      if (sub !== "rotate") throw new UsageError("usage: melogold secret rotate");
      plain(rest, {}, 0);
      return {
        verbose: false,
        run: async (env, output) => (await import("./basic.ts")).secretRotateCommand(env, output),
      };
    }
    default:
      throw new UsageError(`unknown command "${argv.join(" ")}"`);
  }
}

export type RunCliOptions = Readonly<{
  /** The parsed environment (tests); default: `loadEnv()` of the process. */
  env?: Env;
}>;

/** Runs one CLI command and returns the exit code. */
export async function runCli(
  argv: readonly string[],
  output: CliOutput = stdio,
  options: RunCliOptions = {},
): Promise<number> {
  const [command] = argv;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    output.out(usage());
    return EXIT_OK;
  }
  let env: Env;
  try {
    if (command === "version" || command === "--version") {
      env = options.env ?? loadEnv();
      output.out(`melogold-server ${env.APP_VERSION} (${env.GIT_SHA})\n`);
      return EXIT_OK;
    }
    const resolved = resolve(argv);
    env = options.env ?? loadEnv();
    return await resolved.run(env, output, { log: stderrLogger(output, resolved.verbose) });
  } catch (error) {
    if (error instanceof UsageError) {
      output.err(`melogold: ${error.message}\n\n${usage()}`);
      return EXIT_USAGE;
    }
    if (error instanceof EnvError || error instanceof CliError) {
      output.err(`melogold: ${error.message}\n`);
      return EXIT_FAILURE;
    }
    output.err(`melogold: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    return EXIT_FAILURE;
  }
}
