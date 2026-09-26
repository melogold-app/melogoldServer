/**
 * The server address as a QR code in the terminal (`melogold qr`, API §9 "Адрес сервера (QR)"): the clients scan it
 * in «Настройки → Синхронизация → Свой сервер». Two rows of modules per text line (`▀ ▄ █`), a quiet zone of two
 * modules, error correction `M`.
 *
 * With `color` the lines are drawn black on white (ANSI), so the code scans on dark terminals too; without it the
 * modules are the terminal's foreground color.
 */
import qrcode from "qrcode-generator";

/** Modules of empty border around the code. */
export const QR_QUIET_ZONE = 2;

const BLACK_ON_WHITE = "\u001b[30;47m";
const RESET = "\u001b[0m";

/** The rows of the code: `true` is a dark module; the quiet zone included. */
export function qrMatrix(text: string): boolean[][] {
  const code = qrcode(0, "M");
  code.addData(text, "Byte");
  code.make();
  const size = code.getModuleCount();
  const full = size + 2 * QR_QUIET_ZONE;
  const rows: boolean[][] = [];
  for (let y = 0; y < full; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < full; x++) {
      const inside = x >= QR_QUIET_ZONE && y >= QR_QUIET_ZONE && x < size + QR_QUIET_ZONE && y < size + QR_QUIET_ZONE;
      row.push(inside && code.isDark(y - QR_QUIET_ZONE, x - QR_QUIET_ZONE));
    }
    rows.push(row);
  }
  return rows;
}

/** Text lines of the code, two module rows each. */
export function qrLines(text: string, options: Readonly<{ color: boolean }>): string[] {
  const rows = qrMatrix(text);
  const lines: string[] = [];
  for (let y = 0; y < rows.length; y += 2) {
    const top = rows[y] ?? [];
    const bottom = rows[y + 1] ?? [];
    let line = "";
    for (let x = 0; x < top.length; x++) {
      const upper = top[x] === true;
      const lower = bottom[x] === true;
      line += upper && lower ? "█" : upper ? "▀" : lower ? "▄" : " ";
    }
    lines.push(options.color ? `${BLACK_ON_WHITE}${line}${RESET}` : line);
  }
  return lines;
}
