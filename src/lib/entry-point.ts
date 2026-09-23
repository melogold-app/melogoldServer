/**
 * "Is this module the script Node was started with?" for `node src/main.ts`, `node src/healthcheck.ts` and
 * `node scripts/gen-*.ts`. `import.meta.main` would say the same, but only from Node 24.2.0, and `engines` allows
 * every Node 24: on 24.0/24.1 it is `undefined`, so `npm start` would exit 0 without serving and the image
 * healthcheck would always report healthy.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * @param moduleUrl the caller's `import.meta.url`.
 * @param argv the process arguments; `argv[1]` is the script Node was started with.
 */
export function isEntryPoint(moduleUrl: string, argv: readonly string[] = process.argv): boolean {
  const script = argv[1];
  if (script === undefined || !moduleUrl.startsWith("file:")) return false;
  try {
    // Both sides resolved: Node resolves symlinks of the main module unless --preserve-symlinks-main.
    return realpathSync(script) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
