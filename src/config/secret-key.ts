/**
 * Server master key and derived subkeys (DESIGN §4.13, API §8).
 *
 * - Master key: 32 bytes from `MELOGOLD_SECRET_KEY` (64 hex) if set, otherwise from `<DATA_DIR>/secret.key`.
 * - `<DATA_DIR>/secret.key` (mode 0600, 64 lowercase hex characters and a newline) is created on every start when it
 *   is missing, even if the variable is set. The variable is never written to disk: an operator who keeps the key out
 *   of the volume keeps it out. When the variable and the file differ, a warning explains that removing the variable
 *   switches to the file key and ends all sessions.
 * - Subkeys: `HKDF-SHA256(ikm = master key, salt = serverId, info)` with the `info` strings of {@link HKDF_INFO}.
 * - The key is never stored in the database.
 */
import { createHash, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const SECRET_KEY_FILE_NAME = "secret.key";
export const SECRET_KEY_BYTES = 32;
export const SUBKEY_BYTES = 32;

/** HKDF `info` strings (API §8). Changing one invalidates every token signed with the old subkey. */
export const HKDF_INFO = {
  jwtAccess: "melogold/jwt-access/v1",
  refreshToken: "melogold/refresh-token/v1",
  pow: "melogold/pow/v1",
} as const;

export type SubkeyName = keyof typeof HKDF_INFO;
export type Subkeys = Readonly<Record<SubkeyName, Buffer>>;

export type MasterKey = Readonly<{
  key: Buffer;
  /** Where the key in use came from. */
  source: "env" | "file";
  /** Path of the key file (it exists after {@link loadMasterKey}, whatever the source). */
  file: string;
  /** Whether this call created the key file. */
  createdFile: boolean;
}>;

export type LoadMasterKeyOptions = Readonly<{
  dataDir: string;
  /** Parsed `MELOGOLD_SECRET_KEY`: lowercase hex or `null`. */
  envKeyHex: string | null;
  /** Receives operator warnings (pino's `logger.warn.bind(logger)` fits). */
  warn: (message: string) => void;
}>;

export class SecretKeyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SecretKeyError";
  }
}

const KEY_FILE_PATTERN = /^[0-9a-fA-F]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function secretKeyPath(dataDir: string): string {
  return join(dataDir, SECRET_KEY_FILE_NAME);
}

/** A short non-secret fingerprint for logs and support: first 8 hex digits of SHA-256 of the key. */
export function keyFingerprint(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

/**
 * Resolves the master key and makes sure `<dataDir>/secret.key` exists.
 *
 * @throws {SecretKeyError} when the key file exists but is unreadable or malformed. The file is never overwritten:
 *   replacing it would silently end every session. Restore it from a backup, or delete it to start over.
 */
export function loadMasterKey(options: LoadMasterKeyOptions): MasterKey {
  const file = secretKeyPath(options.dataDir);
  mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });

  let fileKey = readKeyFile(file, options.warn);
  let createdFile = false;
  if (fileKey === null) {
    const created = createKeyFile(file, randomBytes(SECRET_KEY_BYTES));
    fileKey = created.key;
    createdFile = created.created;
  }

  if (options.envKeyHex === null) {
    return Object.freeze({ key: fileKey, source: "file", file, createdFile });
  }

  const envKey = decodeEnvKey(options.envKeyHex);
  if (!timingSafeEqual(envKey, fileKey)) {
    options.warn(
      `MELOGOLD_SECRET_KEY differs from ${file}: the variable is used now; if it is removed, the file key takes over ` +
        "and all sessions end.",
    );
  }
  return Object.freeze({ key: envKey, source: "env", file, createdFile });
}

/**
 * Derives the per-purpose subkeys: `HKDF-SHA256(ikm = masterKey, salt = serverId, info)`, 32 bytes each.
 * `serverId` is the lowercase UUID from `server_meta.server_id`, used as its UTF-8 text.
 */
export function deriveSubkeys(masterKey: Buffer, serverId: string): Subkeys {
  if (masterKey.length !== SECRET_KEY_BYTES) {
    throw new SecretKeyError(`master key must be ${SECRET_KEY_BYTES} bytes, got ${masterKey.length}`);
  }
  if (!UUID_PATTERN.test(serverId)) {
    throw new SecretKeyError("serverId must be a lowercase UUID");
  }
  const salt = Buffer.from(serverId, "utf8");
  const derive = (info: string) => Buffer.from(hkdfSync("sha256", masterKey, salt, info, SUBKEY_BYTES));
  return Object.freeze({
    jwtAccess: derive(HKDF_INFO.jwtAccess),
    refreshToken: derive(HKDF_INFO.refreshToken),
    pow: derive(HKDF_INFO.pow),
  });
}

/**
 * Replaces `<dataDir>/secret.key` with a new random key (`melogold secret rotate`). The replacement is atomic:
 * readers see either the old or the new file. Every session ends once the server restarts with the new key;
 * data and recovery codes are unaffected.
 */
export function rotateKeyFile(dataDir: string): void {
  const file = secretKeyPath(dataDir);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const tmp = writeTempKeyFile(dirname(file), randomBytes(SECRET_KEY_BYTES));
  try {
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  fsyncDirectory(dirname(file));
}

// ---------------------------------------------------------------------------------------------------------------------
// File handling
// ---------------------------------------------------------------------------------------------------------------------

function decodeEnvKey(hex: string): Buffer {
  if (!KEY_FILE_PATTERN.test(hex)) throw new SecretKeyError("MELOGOLD_SECRET_KEY must be 64 hex characters");
  return Buffer.from(hex, "hex");
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return undefined;
}

/** Returns the key stored in `file`, or `null` when the file does not exist. */
function readKeyFile(file: string, warn: (message: string) => void): Buffer | null {
  let stats;
  try {
    stats = statSync(file);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw new SecretKeyError(`cannot read ${file}`, { cause: error });
  }
  if (!stats.isFile()) {
    throw new SecretKeyError(`${file} must be a regular file`);
  }
  if ((stats.mode & 0o077) !== 0) {
    warn(`${file} is accessible to other users (mode ${(stats.mode & 0o777).toString(8)}); it should be 0600.`);
  }

  let content: string;
  try {
    content = readFileSync(file, "utf8").trim();
  } catch (error) {
    throw new SecretKeyError(`cannot read ${file}`, { cause: error });
  }
  if (!KEY_FILE_PATTERN.test(content)) {
    throw new SecretKeyError(
      `${file} must contain 64 hex characters. Restore it from a backup; deleting it creates a new key and ends ` +
        "all sessions.",
    );
  }
  return Buffer.from(content, "hex");
}

function writeKey(fd: number, key: Buffer): void {
  writeSync(fd, `${key.toString("hex")}\n`);
  fsyncSync(fd);
}

/** Writes the key into a new 0600 temporary file next to the target and returns its path. */
function writeTempKeyFile(directory: string, key: Buffer): string {
  const tmp = join(directory, `.${SECRET_KEY_FILE_NAME}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeKey(fd, key);
  } catch (error) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw error;
  }
  closeSync(fd);
  return tmp;
}

/** File systems without hard links (some network mounts) report one of these from link(2). */
const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"]);

/**
 * Creates `file` with `key` unless it already exists. The complete file appears atomically (hard link of a fully
 * written temporary file), so a concurrent process (server and CLI) never reads a partial key and never replaces
 * a key that another process has just created. Without hard links it falls back to an exclusive create.
 */
function createKeyFile(file: string, key: Buffer): { key: Buffer; created: boolean } {
  const directory = dirname(file);
  const tmp = writeTempKeyFile(directory, key);
  try {
    linkSync(tmp, file);
  } catch (error) {
    const code = errorCode(error);
    if (code === "EEXIST") return existingKey(file, error);
    if (code === undefined || !NO_HARD_LINKS.has(code)) {
      throw new SecretKeyError(`cannot create ${file}`, { cause: error });
    }
    createKeyFileExclusive(file, key);
  } finally {
    rmSync(tmp, { force: true });
  }
  fsyncDirectory(directory);
  return { key, created: true };
}

function createKeyFileExclusive(file: string, key: Buffer): void {
  let fd: number;
  try {
    fd = openSync(file, "wx", 0o600);
  } catch (error) {
    throw new SecretKeyError(`cannot create ${file}`, { cause: error });
  }
  try {
    writeKey(fd, key);
  } catch (error) {
    closeSync(fd);
    rmSync(file, { force: true });
    throw new SecretKeyError(`cannot write ${file}`, { cause: error });
  }
  closeSync(fd);
}

/** Another process created the file first: use its key. */
function existingKey(file: string, cause: unknown): { key: Buffer; created: boolean } {
  const existing = readKeyFile(file, () => undefined);
  if (existing === null) throw new SecretKeyError(`cannot create ${file}`, { cause });
  return { key: existing, created: false };
}

function fsyncDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(directory, "r");
    fsyncSync(fd);
  } catch {
    // Some platforms and file systems cannot fsync a directory; the file itself is already synced.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
