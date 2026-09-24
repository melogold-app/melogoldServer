/**
 * The conflict rule of every LWW register (DESIGN §3.4): likes, bookmarks, playlist headers, and the membership and
 * position registers of playlist items.
 *
 * ```ts
 * effAt = min(op.at, nowTx)       // a clock in the future is clamped by the server's clock
 * base  = libSeq of the client's cursor when the user acted (null: another epoch or a broken cursor)
 * wins  = reg === null                                   // nothing stored yet
 *      || (base !== null && reg.seq <= base)             // the author had seen the current value
 *      || effAt > reg.at                                 // concurrent edits: the later one wins
 *      || (effAt === reg.at && (dev === reg.dev || dev > (reg.dev ?? "")))   // a tie: the same device, else the larger id
 * ```
 *
 * Device ids are lowercase UUIDs, so `>` on JS strings is the byte order the clients use.
 */

/** A stored register: `seq` of its last write, `*_at` (effAt of that write) and `*_dev` (its author). */
export type Register = Readonly<{ seq: number; at: number; dev: string | null }>;

/** The clock of an op against a register. */
export type OpStamp = Readonly<{ base: number | null; effAt: number; dev: string }>;

/** DESIGN §3.4 `effAt = min(op.at, now)`. */
export function effectiveAt(at: number, now: number): number {
  return Math.min(at, now);
}

/** Whether the op overwrites the register (DESIGN §3.4). */
export function wins(reg: Register | null, op: OpStamp): boolean {
  if (reg === null) return true;
  if (op.base !== null && reg.seq <= op.base) return true;
  if (op.effAt > reg.at) return true;
  return op.effAt === reg.at && (op.dev === reg.dev || op.dev > (reg.dev ?? ""));
}
