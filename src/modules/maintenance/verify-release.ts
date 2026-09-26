/**
 * Release signatures (`melogold verify-release`, DESIGN §7.5 step 2, PLAN T3.1): the host CLI downloads `install.sh`,
 * `SHA256SUMS` and `SHA256SUMS.minisig` of the target release and asks the **current, already trusted** image to check
 * the signature (m25), so a compromised download cannot vouch for itself. The public key is compiled into the image.
 *
 * minisign formats (https://jedisct1.github.io/minisign/):
 * - public key: `untrusted comment: …` line, then base64 of `"Ed"` ‖ key id (8 bytes) ‖ Ed25519 public key (32);
 * - signature: `untrusted comment: …`, base64 of algorithm (`"Ed"`: the file itself is signed; `"ED"`: its
 *   BLAKE2b-512 hash is, the default since minisign 0.10) ‖ key id ‖ signature (64), `trusted comment: …`, base64 of
 *   the global signature: Ed25519 over signature ‖ trusted comment text.
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";

/**
 * The release key of melogold-app/melogoldServer (minisign public key, base64 line). `null` until the maintainer
 * creates it: then every `verify-release` refuses, and upgrades fall back to the checksum alone with a warning.
 */
export const RELEASE_PUBLIC_KEY: string | null = null;

export class ReleaseSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseSignatureError";
  }
}

/** The DER prefix of an Ed25519 SubjectPublicKeyInfo; the 32 raw key bytes follow it. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

type PublicKey = Readonly<{ keyId: Buffer; key: KeyObject }>;

function decodeBase64Line(line: string, what: string): Buffer {
  const text = line.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw new ReleaseSignatureError(`${what} is not base64`);
  return Buffer.from(text, "base64");
}

/** The base64 line of a public key file, or the line itself. */
function keyLine(text: string): string {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  const key = lines.find((line) => !line.startsWith("untrusted comment:"));
  if (key === undefined) throw new ReleaseSignatureError("the public key is empty");
  return key;
}

export function parsePublicKey(text: string): PublicKey {
  const bytes = decodeBase64Line(keyLine(text), "the public key");
  if (bytes.length !== 42 || bytes.subarray(0, 2).toString("latin1") !== "Ed") {
    throw new ReleaseSignatureError("not a minisign Ed25519 public key");
  }
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, bytes.subarray(10, 42)]),
    format: "der",
    type: "spki",
  });
  return Object.freeze({ keyId: Buffer.from(bytes.subarray(2, 10)), key });
}

export type ParsedSignature = Readonly<{
  prehashed: boolean;
  keyId: Buffer;
  signature: Buffer;
  trustedComment: string;
  globalSignature: Buffer;
}>;

export function parseSignature(text: string): ParsedSignature {
  const lines = text.split(/\r?\n/);
  const [untrusted, signatureLine, trustedLine, globalLine] = lines;
  if (untrusted?.startsWith("untrusted comment:") !== true) {
    throw new ReleaseSignatureError("the signature does not start with an untrusted comment");
  }
  if (
    signatureLine === undefined ||
    trustedLine?.startsWith("trusted comment: ") !== true ||
    globalLine === undefined
  ) {
    throw new ReleaseSignatureError("the signature file is incomplete");
  }
  const bytes = decodeBase64Line(signatureLine, "the signature");
  const algorithm = bytes.subarray(0, 2).toString("latin1");
  if (bytes.length !== 74 || (algorithm !== "Ed" && algorithm !== "ED")) {
    throw new ReleaseSignatureError("not a minisign Ed25519 signature");
  }
  const globalSignature = decodeBase64Line(globalLine, "the global signature");
  if (globalSignature.length !== 64) throw new ReleaseSignatureError("the global signature has a wrong length");
  return Object.freeze({
    prehashed: algorithm === "ED",
    keyId: Buffer.from(bytes.subarray(2, 10)),
    signature: Buffer.from(bytes.subarray(10, 74)),
    trustedComment: trustedLine.slice("trusted comment: ".length),
    globalSignature,
  });
}

/**
 * Checks a minisign signature of `message`.
 * @returns the trusted comment (e.g. `timestamp:… file:SHA256SUMS hashed`).
 * @throws ReleaseSignatureError when the key, the signature or the message does not match.
 */
export function verifyMinisign(publicKeyText: string, signatureText: string, message: Buffer): string {
  const publicKey = parsePublicKey(publicKeyText);
  const parsed = parseSignature(signatureText);
  if (!parsed.keyId.equals(publicKey.keyId)) {
    throw new ReleaseSignatureError("the signature was made with another key");
  }
  const signed = parsed.prehashed ? createHash("blake2b512").update(message).digest() : message;
  if (!verify(null, signed, publicKey.key, parsed.signature)) {
    throw new ReleaseSignatureError("the signature does not match the file");
  }
  const global = Buffer.concat([parsed.signature, Buffer.from(parsed.trustedComment, "utf8")]);
  if (!verify(null, global, publicKey.key, parsed.globalSignature)) {
    throw new ReleaseSignatureError("the trusted comment was altered");
  }
  return parsed.trustedComment;
}

/** `SHA256SUMS` lines (`<64 hex>  <name>`, `*` binary marker allowed) as name → hash. */
export function parseChecksums(text: string): ReadonlyMap<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new ReleaseSignatureError(`not a SHA256SUMS line: ${line}`);
    }
    sums.set(match[2], match[1]);
  }
  return sums;
}

/**
 * Checks files against a verified `SHA256SUMS`: each must be listed (by its base name) with its exact hash.
 * @throws ReleaseSignatureError naming the first file that does not match.
 */
export function verifyChecksums(
  sums: ReadonlyMap<string, string>,
  files: readonly { name: string; bytes: Buffer }[],
): void {
  for (const file of files) {
    const expected = sums.get(file.name);
    if (expected === undefined) throw new ReleaseSignatureError(`${file.name} is not in SHA256SUMS`);
    const actual = createHash("sha256").update(file.bytes).digest("hex");
    if (actual !== expected) throw new ReleaseSignatureError(`${file.name} does not match its SHA256SUMS line`);
  }
}
