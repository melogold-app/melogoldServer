/**
 * `melogold qr`: a QR code with its quiet zone and finder patterns, two module rows per line, black on white with
 * `color`; the address is printed under it; a missing or non-http address is a usage error.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseEnv } from "../config/env.ts";
import { captureOutput } from "../test/cli-output.ts";
import { EXIT_USAGE, runCli } from "./index.ts";
import { QR_QUIET_ZONE, qrLines, qrMatrix } from "./qr.ts";

const URL_TEXT = "https://178-250-187-202.sslip.io";

/** The 7×7 finder pattern: a dark ring, a light ring, a dark 3×3 centre. */
function hasFinderAt(rows: boolean[][], top: number, left: number): boolean {
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 7; x++) {
      const ring = Math.max(Math.abs(y - 3), Math.abs(x - 3));
      const dark = ring !== 2;
      if (rows[top + y]?.[left + x] !== dark) return false;
    }
  }
  return true;
}

describe("qr", () => {
  test("the matrix has the quiet zone and the three finder patterns", () => {
    const rows = qrMatrix(URL_TEXT);
    const size = rows.length - 2 * QR_QUIET_ZONE;
    assert.equal((size - 17) % 4, 0, "a QR code is 17 + 4·version modules wide");
    assert.ok(rows.every((row) => row.length === rows.length));
    assert.ok(rows.slice(0, QR_QUIET_ZONE).every((row) => row.every((dark) => !dark)));
    assert.ok(rows.every((row) => row.slice(0, QR_QUIET_ZONE).every((dark) => !dark)));
    assert.ok(hasFinderAt(rows, QR_QUIET_ZONE, QR_QUIET_ZONE));
    assert.ok(hasFinderAt(rows, QR_QUIET_ZONE, QR_QUIET_ZONE + size - 7));
    assert.ok(hasFinderAt(rows, QR_QUIET_ZONE + size - 7, QR_QUIET_ZONE));
  });

  test("two module rows per line; colors only when asked", () => {
    const rows = qrMatrix(URL_TEXT);
    const plain = qrLines(URL_TEXT, { color: false });
    assert.equal(plain.length, Math.ceil(rows.length / 2));
    assert.ok(plain.every((line) => /^[ ▀▄█]+$/.test(line)));
    const colored = qrLines(URL_TEXT, { color: true });
    assert.ok(colored.every((line) => line.startsWith("\u001b[30;47m") && line.endsWith("\u001b[0m")));
  });

  test("the command prints the code and the address; PUBLIC_URL is the default", async () => {
    const env = parseEnv({ NODE_ENV: "test", PUBLIC_URL: URL_TEXT });
    const captured = captureOutput();
    assert.equal(await runCli(["qr", "--plain"], captured.output, { env }), 0);
    assert.ok(captured.stdout().endsWith(`\n\n${URL_TEXT}\n`));
    assert.ok(!captured.stdout().includes("\u001b["));

    const tty = captureOutput({ isTty: true });
    assert.equal(await runCli(["qr", "http://192.168.1.50:8080"], tty.output, { env }), 0);
    assert.ok(tty.stdout().includes("\u001b[30;47m"));
    assert.ok(tty.stdout().endsWith("\n\nhttp://192.168.1.50:8080\n"));
  });

  test("no address, or not http(s), is a usage error", async () => {
    const env = parseEnv({ NODE_ENV: "test" });
    const none = captureOutput();
    assert.equal(await runCli(["qr"], none.output, { env }), EXIT_USAGE);
    assert.match(none.stderr(), /no address/);
    const ftp = captureOutput();
    assert.equal(await runCli(["qr", "ftp://example.com"], ftp.output, { env }), EXIT_USAGE);
    assert.match(ftp.stderr(), /must be http\(s\)/);
  });
});
