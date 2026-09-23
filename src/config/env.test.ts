import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { EnvError, isTrustProxyEntry, parseDatabaseUrl, parseEnv } from "./env.ts";
import type { EnvSource } from "./env.ts";

function issuesOf(source: EnvSource): readonly string[] {
  try {
    parseEnv(source);
  } catch (error) {
    assert.ok(error instanceof EnvError, `expected EnvError, got ${String(error)}`);
    return error.issues;
  }
  assert.fail("parseEnv accepted an invalid environment");
}

function assertRejected(source: EnvSource, key: string): void {
  const issues = issuesOf(source);
  assert.ok(
    issues.some((issue) => issue.startsWith(`${key}:`)),
    `expected an issue for ${key}, got ${JSON.stringify(issues)}`,
  );
}

describe("parseEnv", () => {
  test("an empty environment yields the documented defaults (API §10)", () => {
    assert.deepEqual(parseEnv({}), {
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: 8080,
      PUBLIC_URL: null,
      INSTANCE_NAME: "Melogold",
      SOURCE_URL: "https://github.com/melogold-app/melogoldServer/tree/unknown",
      PRIVACY_URL: null,
      CONTACT: null,
      DATA_DIR: "/data",
      DATABASE_URL: { dialect: "sqlite", url: "sqlite:///data/melogold.db", path: "/data/melogold.db", memory: false },
      SQLITE_BUSY_TIMEOUT_MS: 5000,
      SQLITE_SYNCHRONOUS: "FULL",
      DATABASE_POOL_MAX: 10,
      DATABASE_SSL: "disable",
      DATABASE_SSL_CA_FILE: null,
      DATABASE_STATEMENT_TIMEOUT_MS: 15_000,
      MIGRATE_ON_START: true,
      SCHEMA_CHECK: "strict",
      LOG_LEVEL: "info",
      TRUST_PROXY: [],
      CORS_ORIGINS: [],
      HTTP_COMPRESSION: true,
      OPENAPI_DOCS_UI: false,
      SHUTDOWN_GRACE_MS: 10_000,
      MELOGOLD_SECRET_KEY: null,
      ACCESS_TOKEN_TTL_SECONDS: 900,
      REFRESH_TOKEN_TTL_DAYS: 90,
      REFRESH_GRACE_SECONDS: 86_400,
      RESTORE_REFRESH_GRACE_DAYS: 3,
      REGISTRATION: "first",
      REGISTRATION_POW_BITS: 0,
      REGISTRATION_POW_SOFT_PER_HOUR: 60,
      RESERVED_LOGINS: [],
      MAX_DEVICES_PER_USER: 20,
      DEVICE_INACTIVE_DAYS: 180,
      NEW_DEVICE_RESTRICT_HOURS: 24,
      LINK_TTL_SECONDS: 300,
      LINK_NETWORK_HINT: true,
      ARGON2_MEMORY_KIB: 65_536,
      ARGON2_TIME_COST: 3,
      ARGON2_PARALLELISM: 1,
      ARGON2_MAX_CONCURRENCY: 2,
      ARGON2_QUEUE_LIMIT: 32,
      SSE_HEARTBEAT_SECONDS: 25,
      SSE_MAX_STREAMS_PER_DEVICE: 4,
      SSE_MAX_STREAMS_PER_USER: 64,
      RATE_LIMIT_ENABLED: true,
      HISTORY_RETENTION_DAYS: 400,
      HISTORY_MAX_EVENTS: 50_000,
      HISTORY_MERGE_UPLOAD_MAX: 20_000,
      SYNC_OPS_RETENTION_DAYS: 180,
      PLAYBACK_RETENTION_DAYS: 30,
      RETENTION_RUN_AT_UTC: { hour: 4, minute: 30 },
      DISK_MIN_FREE_PERCENT: 10,
      APP_VERSION: "0.0.0-dev",
      GIT_SHA: "unknown",
      TZ: null,
    });
  });

  test("the image environment of DESIGN §7.1 parses", () => {
    const env = parseEnv({
      NODE_ENV: "production",
      TZ: "UTC",
      HOST: "0.0.0.0",
      PORT: "8080",
      DATA_DIR: "/data",
      DATABASE_URL: "sqlite:///data/melogold.db",
      APP_VERSION: "0.1.0-rc.1",
      GIT_SHA: "3f9c2ab1d0e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8",
    });
    assert.equal(env.HOST, "0.0.0.0");
    assert.equal(env.TZ, "UTC");
    assert.equal(env.APP_VERSION, "0.1.0-rc.1");
    assert.equal(
      env.SOURCE_URL,
      "https://github.com/melogold-app/melogoldServer/tree/3f9c2ab1d0e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8",
    );
  });

  test("empty and blank values mean unset; values are trimmed; unknown variables are ignored", () => {
    const env = parseEnv({ PUBLIC_URL: "", INSTANCE_NAME: "   ", PORT: " 9090 ", SOMETHING_ELSE: "x", PATH: "/bin" });
    assert.equal(env.PUBLIC_URL, null);
    assert.equal(env.INSTANCE_NAME, "Melogold");
    assert.equal(env.PORT, 9090);
    assert.equal(Object.hasOwn(env, "SOMETHING_ELSE"), false);
  });

  test("is pure: the input is not modified and equal inputs give equal results", () => {
    const source = { PORT: " 8081 ", RESERVED_LOGINS: "Admin, root" };
    const snapshot = { ...source };
    assert.deepEqual(parseEnv(source), parseEnv(source));
    assert.deepEqual(source, snapshot);
  });

  test("the result is frozen", () => {
    const env = parseEnv({ TRUST_PROXY: "127.0.0.1/32" });
    assert.ok(Object.isFrozen(env));
    assert.ok(Object.isFrozen(env.TRUST_PROXY));
    assert.ok(Object.isFrozen(env.DATABASE_URL));
    assert.ok(Object.isFrozen(env.RETENTION_RUN_AT_UTC));
  });

  test("EnvError lists every invalid variable at once", () => {
    const issues = issuesOf({ PORT: "0", REGISTRATION: "invite", LOG_LEVEL: "verbose" });
    assert.equal(issues.length, 3);
    for (const key of ["PORT", "REGISTRATION", "LOG_LEVEL"]) {
      assert.ok(
        issues.some((issue) => issue.startsWith(`${key}: `)),
        key,
      );
    }
  });

  describe("integer ranges", () => {
    const bounded: [key: string, min: number, max: number][] = [
      ["PORT", 1, 65_535],
      ["SQLITE_BUSY_TIMEOUT_MS", 100, 60_000],
      ["DATABASE_POOL_MAX", 1, 50],
      ["ACCESS_TOKEN_TTL_SECONDS", 300, 3600],
      ["REFRESH_TOKEN_TTL_DAYS", 7, 365],
      ["REFRESH_GRACE_SECONDS", 60, 604_800],
      ["RESTORE_REFRESH_GRACE_DAYS", 0, 14],
      ["REGISTRATION_POW_BITS", 0, 26],
      ["LINK_TTL_SECONDS", 60, 900],
      ["ARGON2_PARALLELISM", 1, 4],
      ["SSE_HEARTBEAT_SECONDS", 5, 60],
      ["DISK_MIN_FREE_PERCENT", 1, 50],
    ];
    for (const [key, min, max] of bounded) {
      test(`${key} accepts ${min}..${max} only`, () => {
        assert.equal(parseEnv({ [key]: String(min) })[key as "PORT"], min);
        assert.equal(parseEnv({ [key]: String(max) })[key as "PORT"], max);
        assertRejected({ [key]: String(min - 1) }, key);
        assertRejected({ [key]: String(max + 1) }, key);
      });
    }

    const lowerBounded: [key: string, min: number][] = [
      ["ARGON2_MEMORY_KIB", 19_456],
      ["ARGON2_TIME_COST", 2],
      ["HISTORY_RETENTION_DAYS", 366],
      ["SYNC_OPS_RETENTION_DAYS", 30],
    ];
    for (const [key, min] of lowerBounded) {
      test(`${key} accepts ${min} and more`, () => {
        assert.equal(parseEnv({ [key]: String(min) })[key as "PORT"], min);
        assertRejected({ [key]: String(min - 1) }, key);
      });
    }

    test("non-integers are rejected, not coerced", () => {
      for (const value of ["abc", "1.5", "1e3", "0x10", "12px", "+5"]) {
        assertRejected({ PORT: value }, "PORT");
      }
    });
  });

  describe("enumerations and booleans", () => {
    test("enumerations accept only the documented values", () => {
      assert.equal(parseEnv({ NODE_ENV: "test" }).NODE_ENV, "test");
      assert.equal(parseEnv({ SQLITE_SYNCHRONOUS: "NORMAL" }).SQLITE_SYNCHRONOUS, "NORMAL");
      assert.equal(parseEnv({ DATABASE_SSL: "verify-full" }).DATABASE_SSL, "verify-full");
      assert.equal(parseEnv({ SCHEMA_CHECK: "warn" }).SCHEMA_CHECK, "warn");
      assert.equal(parseEnv({ REGISTRATION: "open" }).REGISTRATION, "open");
      assert.equal(parseEnv({ LOG_LEVEL: "silent" }).LOG_LEVEL, "silent");
      assertRejected({ NODE_ENV: "staging" }, "NODE_ENV");
      assertRejected({ SQLITE_SYNCHRONOUS: "OFF" }, "SQLITE_SYNCHRONOUS");
      assertRejected({ DATABASE_SSL: "prefer" }, "DATABASE_SSL");
      assertRejected({ SCHEMA_CHECK: "off" }, "SCHEMA_CHECK");
      assertRejected({ REGISTRATION: "invite" }, "REGISTRATION");
    });

    test("booleans", () => {
      assert.equal(parseEnv({ RATE_LIMIT_ENABLED: "false" }).RATE_LIMIT_ENABLED, false);
      assert.equal(parseEnv({ OPENAPI_DOCS_UI: "TRUE" }).OPENAPI_DOCS_UI, true);
      assert.equal(parseEnv({ LINK_NETWORK_HINT: "0" }).LINK_NETWORK_HINT, false);
      assert.equal(parseEnv({ MIGRATE_ON_START: "1" }).MIGRATE_ON_START, true);
      assertRejected({ HTTP_COMPRESSION: "maybe" }, "HTTP_COMPRESSION");
    });
  });

  describe("DATABASE_URL", () => {
    test("sqlite, memory and postgres forms", () => {
      assert.deepEqual(parseEnv({ DATABASE_URL: "sqlite://./.data/melogold.db" }).DATABASE_URL, {
        dialect: "sqlite",
        url: "sqlite://./.data/melogold.db",
        path: "./.data/melogold.db",
        memory: false,
      });
      assert.deepEqual(parseEnv({ NODE_ENV: "test", DATABASE_URL: "sqlite::memory:" }).DATABASE_URL, {
        dialect: "sqlite",
        url: "sqlite::memory:",
        path: ":memory:",
        memory: true,
      });
      for (const url of ["postgres://melogold:secret@db:5432/melogold", "postgresql://u@localhost/melogold"]) {
        assert.deepEqual(parseEnv({ DATABASE_URL: url }).DATABASE_URL, { dialect: "postgres", url });
      }
    });

    test("the default follows DATA_DIR", () => {
      assert.deepEqual(parseEnv({ DATA_DIR: "/srv/melogold/" }).DATABASE_URL, {
        dialect: "sqlite",
        url: "sqlite:///srv/melogold/melogold.db",
        path: "/srv/melogold/melogold.db",
        memory: false,
      });
    });

    test("sqlite::memory: is refused in production", () => {
      assertRejected({ DATABASE_URL: "sqlite::memory:" }, "DATABASE_URL");
      assertRejected({ NODE_ENV: "production", DATABASE_URL: "sqlite::memory:" }, "DATABASE_URL");
      assert.equal(
        parseEnv({ NODE_ENV: "development", DATABASE_URL: "sqlite::memory:" }).DATABASE_URL.dialect,
        "sqlite",
      );
    });

    test("other schemes and malformed values are rejected", () => {
      for (const url of [
        "mysql://localhost/db",
        "sqlite://",
        "sqlite:relative.db",
        "/data/melogold.db",
        "postgres://[::1",
      ]) {
        assertRejected({ DATABASE_URL: url }, "DATABASE_URL");
      }
      assert.ok("error" in parseDatabaseUrl("file:///data/x.db"));
    });

    test("error messages never contain the value (it may hold a password)", () => {
      const issues = issuesOf({ DATABASE_URL: "postgres://user:hunter2@[bad" });
      assert.equal(
        issues.some((issue) => issue.includes("hunter2")),
        false,
      );
    });
  });

  describe("URLs and names", () => {
    test("PUBLIC_URL: absolute http(s) base URL without a trailing slash", () => {
      assert.equal(parseEnv({ PUBLIC_URL: "https://api.melogold.app" }).PUBLIC_URL, "https://api.melogold.app");
      assert.equal(parseEnv({ PUBLIC_URL: "http://192.168.1.50:8080" }).PUBLIC_URL, "http://192.168.1.50:8080");
      assert.equal(parseEnv({ PUBLIC_URL: "https://example.com/melogold" }).PUBLIC_URL, "https://example.com/melogold");
      assert.equal(parseEnv({ PUBLIC_URL: "https://Music.Example.COM" }).PUBLIC_URL, "https://music.example.com");
      assert.equal(parseEnv({ PUBLIC_URL: "http://[::1]:8080" }).PUBLIC_URL, "http://[::1]:8080");
      for (const url of [
        "https://api.melogold.app/",
        "https://example.com/melogold/",
        "ftp://example.com",
        "api.melogold.app",
        "https://example.com?x=1",
        "https://example.com#top",
        "https://user:pass@example.com",
        "HTTPS://example.com",
      ]) {
        assertRejected({ PUBLIC_URL: url }, "PUBLIC_URL");
      }
    });

    test("SOURCE_URL replaces {rev} with GIT_SHA and must be an http(s) URL", () => {
      assert.equal(
        parseEnv({ GIT_SHA: "3f9c2ab" }).SOURCE_URL,
        "https://github.com/melogold-app/melogoldServer/tree/3f9c2ab",
      );
      assert.equal(
        parseEnv({ SOURCE_URL: "https://git.example.com/fork/-/tree/{rev}", GIT_SHA: "abcdef0" }).SOURCE_URL,
        "https://git.example.com/fork/-/tree/abcdef0",
      );
      assert.equal(
        parseEnv({ SOURCE_URL: "https://example.com/fork", GIT_SHA: "abcdef0" }).SOURCE_URL,
        "https://example.com/fork",
      );
      assertRejected({ SOURCE_URL: "git@github.com:fork/melogold.git" }, "SOURCE_URL");
    });

    test("PRIVACY_URL must be an http(s) URL; CONTACT is free text", () => {
      const env = parseEnv({ PRIVACY_URL: "https://melogold.app/privacy", CONTACT: "abuse@example.com" });
      assert.equal(env.PRIVACY_URL, "https://melogold.app/privacy");
      assert.equal(env.CONTACT, "abuse@example.com");
      assertRejected({ PRIVACY_URL: "melogold.app/privacy" }, "PRIVACY_URL");
      assertRejected({ PRIVACY_URL: `https://example.com/${"a".repeat(2048)}` }, "PRIVACY_URL");
    });

    test("INSTANCE_NAME: 1..64 UTF-16 units, no control characters", () => {
      assert.equal(parseEnv({ INSTANCE_NAME: "  Дом  " }).INSTANCE_NAME, "Дом");
      assert.equal(parseEnv({ INSTANCE_NAME: "x".repeat(64) }).INSTANCE_NAME.length, 64);
      assertRejected({ INSTANCE_NAME: "x".repeat(65) }, "INSTANCE_NAME");
      assertRejected({ INSTANCE_NAME: `${"x".repeat(63)}🎵` }, "INSTANCE_NAME");
      assertRejected({ INSTANCE_NAME: "Home\u0007" }, "INSTANCE_NAME");
    });

    test("APP_VERSION must be semver, GIT_SHA a hex commit or 'unknown'", () => {
      assert.equal(parseEnv({ APP_VERSION: "1.2.3" }).APP_VERSION, "1.2.3");
      assertRejected({ APP_VERSION: "v1.2.3" }, "APP_VERSION");
      assertRejected({ APP_VERSION: "latest" }, "APP_VERSION");
      assertRejected({ GIT_SHA: "main" }, "GIT_SHA");
      assertRejected({ GIT_SHA: "3F9C2AB" }, "GIT_SHA");
    });
  });

  describe("lists", () => {
    test("TRUST_PROXY accepts IPs, CIDRs, IPv4 netmasks and proxy-addr names", () => {
      const env = parseEnv({
        TRUST_PROXY: "127.0.0.1/32, ::1/128 ,172.30.83.0/24,10.0.0.0/255.0.0.0,loopback,10.1.2.3",
      });
      assert.deepEqual(env.TRUST_PROXY, [
        "127.0.0.1/32",
        "::1/128",
        "172.30.83.0/24",
        "10.0.0.0/255.0.0.0",
        "loopback",
        "10.1.2.3",
      ]);
      for (const entry of ["2001:db8::/56", "fe80::1", "0.0.0.0/0", "uniquelocal", "linklocal"]) {
        assert.ok(isTrustProxyEntry(entry), entry);
      }
      for (const entry of ["1", "10.0.0.0/33", "::1/129", "256.1.1.1", "10.0.0.0/255.0.255.0", "example.com", "*"]) {
        assert.equal(isTrustProxyEntry(entry), false, entry);
        assertRejected({ TRUST_PROXY: entry }, "TRUST_PROXY");
      }
    });

    test("CORS_ORIGINS accepts exact origins only", () => {
      assert.deepEqual(parseEnv({ CORS_ORIGINS: "https://app.example.com, http://localhost:5173" }).CORS_ORIGINS, [
        "https://app.example.com",
        "http://localhost:5173",
      ]);
      for (const origin of ["https://app.example.com/", "https://app.example.com/path", "*", "app.example.com"]) {
        assertRejected({ CORS_ORIGINS: origin }, "CORS_ORIGINS");
      }
    });

    test("RESERVED_LOGINS are normalized like logins and deduplicated", () => {
      assert.deepEqual(parseEnv({ RESERVED_LOGINS: "Admin, ＲＯＯＴ,admin,, support " }).RESERVED_LOGINS, [
        "admin",
        "root",
        "support",
      ]);
    });
  });

  describe("special values", () => {
    test("MAX_DEVICES_PER_USER=0 means no limit", () => {
      assert.equal(parseEnv({ MAX_DEVICES_PER_USER: "0" }).MAX_DEVICES_PER_USER, null);
      assert.equal(parseEnv({ MAX_DEVICES_PER_USER: "5" }).MAX_DEVICES_PER_USER, 5);
      assertRejected({ MAX_DEVICES_PER_USER: "-1" }, "MAX_DEVICES_PER_USER");
    });

    test("HISTORY_MERGE_UPLOAD_MAX must not exceed HISTORY_MAX_EVENTS", () => {
      assert.equal(parseEnv({ HISTORY_MAX_EVENTS: "1000", HISTORY_MERGE_UPLOAD_MAX: "1000" }).HISTORY_MAX_EVENTS, 1000);
      assertRejected({ HISTORY_MAX_EVENTS: "1000", HISTORY_MERGE_UPLOAD_MAX: "1001" }, "HISTORY_MERGE_UPLOAD_MAX");
      assertRejected({ HISTORY_MAX_EVENTS: "10000" }, "HISTORY_MERGE_UPLOAD_MAX");
    });

    test("RETENTION_RUN_AT_UTC is HH:MM", () => {
      assert.deepEqual(parseEnv({ RETENTION_RUN_AT_UTC: "00:05" }).RETENTION_RUN_AT_UTC, { hour: 0, minute: 5 });
      assert.deepEqual(parseEnv({ RETENTION_RUN_AT_UTC: "23:59" }).RETENTION_RUN_AT_UTC, { hour: 23, minute: 59 });
      for (const value of ["24:00", "4:30", "04:60", "04-30", "04:30:00"]) {
        assertRejected({ RETENTION_RUN_AT_UTC: value }, "RETENTION_RUN_AT_UTC");
      }
    });

    test("MELOGOLD_SECRET_KEY is 64 hex characters, stored lowercase, never echoed in errors", () => {
      const key = "AB".repeat(32);
      assert.equal(parseEnv({ MELOGOLD_SECRET_KEY: key }).MELOGOLD_SECRET_KEY, "ab".repeat(32));
      const secret = "c0ffee".repeat(10);
      const issues = issuesOf({ MELOGOLD_SECRET_KEY: secret });
      assert.equal(issues.length, 1);
      assert.equal(issues[0]?.includes(secret), false);
      assertRejected({ MELOGOLD_SECRET_KEY: "zz".repeat(32) }, "MELOGOLD_SECRET_KEY");
    });
  });
});
