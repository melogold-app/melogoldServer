/**
 * Entry point (DESIGN §6.3, §7.1): `main(argv)`.
 *
 * - `serve` (also no argument): the HTTP server (`server.ts`, which loads Fastify);
 * - anything else: the CLI (`cli/index.ts`), which **never loads Fastify** (both are imported lazily).
 *
 * The image's launcher `docker/melogold` calls `main(process.argv.slice(2))`; `node src/main.ts serve` (npm start,
 * npm run dev) runs it directly.
 */

export async function main(argv: readonly string[]): Promise<void> {
  const [command = "serve", ...rest] = argv;
  if (command === "serve") {
    const { runServer } = await import("./server.ts");
    await runServer(rest);
    return;
  }
  const { runCli } = await import("./cli/index.ts");
  process.exitCode = await runCli([command, ...rest]);
}

if (import.meta.main) await main(process.argv.slice(2));
