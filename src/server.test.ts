/** Startup helpers of `server.ts`: the `/data` mount check of DESIGN §7.1. */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isMountPoint, warnIfDataNotMounted } from "./server.ts";

const MOUNTINFO = [
  "612 530 0:141 / / ro,relatime master:233 - overlay overlay rw,lowerdir=/x",
  "640 612 254:1 /docker/volumes/melogold-data/_data /data rw,relatime - ext4 /dev/vda1 rw",
  "641 612 254:1 /x /with\\040space rw - ext4 /dev/vda1 rw",
  "",
].join("\n");

describe("the /data mount check", () => {
  test("mount points are field 5 of /proc/self/mountinfo, with octal escapes", () => {
    assert.ok(isMountPoint(MOUNTINFO, "/data"));
    assert.ok(isMountPoint(MOUNTINFO, "/data/"));
    assert.ok(isMountPoint(MOUNTINFO, "/with space"));
    assert.ok(isMountPoint(MOUNTINFO, "/"));
    assert.ok(!isMountPoint(MOUNTINFO, "/app"));
  });

  test("warns only for DATA_DIR=/data on Linux without a mount", () => {
    const warnings: string[] = [];
    const log = { warn: (_details: object, message: string) => warnings.push(message) };
    warnIfDataNotMounted({ DATA_DIR: "/data" }, log, MOUNTINFO);
    warnIfDataNotMounted({ DATA_DIR: "/data" }, log, null);
    warnIfDataNotMounted({ DATA_DIR: "./.data" }, log, "");
    assert.equal(warnings.length, 0);
    warnIfDataNotMounted({ DATA_DIR: "/data" }, log, MOUNTINFO.replace(" /data ", " /other "));
    assert.equal(warnings.length, 1);
    assert.match(warnings.join(""), /NOT a mounted volume/);
  });
});
