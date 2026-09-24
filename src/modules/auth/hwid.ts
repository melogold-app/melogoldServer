/**
 * Hardware id of a device (API §1.6 `Hwid`, DESIGN §4.6). Clients compute it; the server only stores `sha256(hwid)`
 * (`devices.hwid_hash`) and compares it on login (known device) and refresh (`device_mismatch`). The function is here
 * for the vectors of `spec/hwid.vectors.json` and for test clients.
 *
 * `hwid = hex(sha256("melogold-hwid-v1|" + platformId + "|" + serverId))`, one per server:
 *
 * | Platform | `platformId`                              |
 * | -------- | ----------------------------------------- |
 * | Android  | `ANDROID_ID`                              |
 * | macOS    | `IOPlatformUUID`                          |
 * | Windows  | `MachineGuid + "|" + installSalt`         |
 * | Linux    | `/etc/machine-id + "|" + installSalt`     |
 * | fallback | a random UUID kept in private storage     |
 */
import { sha256Hex } from "../../lib/crypto.ts";

/** API §8. */
export const HWID_PREFIX = "melogold-hwid-v1|";

export function computeHwid(platformId: string, serverId: string): string {
  return sha256Hex(`${HWID_PREFIX}${platformId}|${serverId}`);
}

/** `devices.hwid_hash`: SHA-256 hex of the hwid text. */
export function hwidHash(hwid: string): string {
  return sha256Hex(hwid);
}
