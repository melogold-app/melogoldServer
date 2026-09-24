/**
 * The sync cursor (API §1.6 `Cursor`, DESIGN §3.6): `"<epoch 8 hex>.<libSeq>.<histSeq>"`, or `""` for both streams
 * from zero. Opaque to clients; the server reads it in three places:
 *
 * - {@link parseCursor}: `SyncRequest.cursor` against the head of the user. Not the format → `400 invalid_request`;
 *   another `epoch` or a part beyond `head.seq` → `410 cursor_invalid`; a part below `floor_seq` →
 *   `410 cursor_expired {floorCursor}` (in the MVP `floor_seq` is always 0).
 * - {@link baseSeq}: `SyncOp.base`, leniently: the `libSeq` of the client's cursor when the user acted, or `null`
 *   (another epoch, a broken cursor, a part beyond the head) — the op then has no causal information (DESIGN §3.4).
 * - {@link formatCursor} / {@link headCursor}: the cursor of a response and of `sync.changed`.
 */
import { CURSOR_PATTERN } from "../../contract/common.ts";
import type { SyncStream } from "../../contract/sync.ts";
import type { Head } from "../../db/heads.ts";
import { AppError } from "../../http/errors.ts";

/** How far a client has read each stream (`libSeq`, `histSeq`). */
export type CursorPosition = Readonly<{ lib: number; hist: number }>;

/** `""`: both streams from zero. */
export const START_POSITION: CursorPosition = Object.freeze({ lib: 0, hist: 0 });

/**
 * A cursor split into its parts. A part of 16 digits may exceed 2^53 − 1 and lose precision as a number; it still
 * compares above every head (`head.seq` ≤ 2^53 − 1), which is all the server needs.
 */
export type DecodedCursor = Readonly<{ epoch: string; lib: number; hist: number }>;

/**
 * Splits a cursor.
 * @returns `"start"` for `""`, the parts for a well-formed cursor, `null` for anything else.
 */
export function decodeCursor(text: string): DecodedCursor | "start" | null {
  if (text === "") return "start";
  if (!CURSOR_PATTERN.test(text)) return null;
  const [epoch = "", lib = "", hist = ""] = text.split(".");
  return Object.freeze({ epoch, lib: Number(lib), hist: Number(hist) });
}

export function formatCursor(epoch: string, lib: number, hist: number): string {
  return `${epoch}.${lib}.${hist}`;
}

/** The cursor at the head: both streams read up to `head.seq`. */
export function headCursor(head: Pick<Head, "epoch" | "seq">): string {
  return formatCursor(head.epoch, head.seq, head.seq);
}

/**
 * The position of `text` against the head of its user (DESIGN §3.6 "Разбор курсора").
 * @throws AppError `invalid_request` (not a cursor), `cursor_invalid` (another epoch or beyond the head),
 *   `cursor_expired` (below `floor_seq`).
 */
export function parseCursor(text: string, head: Pick<Head, "epoch" | "seq" | "floorSeq">): CursorPosition {
  const decoded = decodeCursor(text);
  if (decoded === "start") return START_POSITION;
  if (decoded === null) {
    throw new AppError("invalid_request", { details: { issues: [{ path: "cursor", code: "invalid_format" }] } });
  }
  // Unsafe integers (16 digits) are necessarily beyond the head: head.seq ≤ 2^53 − 1.
  if (decoded.epoch !== head.epoch || decoded.lib > head.seq || decoded.hist > head.seq) {
    throw new AppError("cursor_invalid");
  }
  if (decoded.lib < head.floorSeq || decoded.hist < head.floorSeq) {
    throw new AppError("cursor_expired", {
      details: { floorCursor: formatCursor(head.epoch, head.floorSeq, head.floorSeq) },
    });
  }
  return Object.freeze({ lib: decoded.lib, hist: decoded.hist });
}

/**
 * `SyncOp.base` → `libSeq` for the conflict rule (DESIGN §3.4), never an error: absent, broken, another epoch or
 * beyond the head → `null` (no causal information). `""` → `0` (the client had seen nothing).
 */
export function baseSeq(base: string | undefined, head: Pick<Head, "epoch" | "seq">): number | null {
  if (base === undefined) return null;
  const decoded = decodeCursor(base);
  if (decoded === "start") return 0;
  if (decoded === null) return null;
  if (decoded.epoch !== head.epoch || decoded.lib > head.seq) return null;
  return decoded.lib;
}

/** Whether every requested stream of `position` is already at the head (nothing to read). */
export function atHead(position: CursorPosition, headSeq: number, streams: readonly SyncStream[]): boolean {
  return streams.every((stream) => (stream === "library" ? position.lib : position.hist) >= headSeq);
}
