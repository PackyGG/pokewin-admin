import assert from "node:assert/strict";
import test from "node:test";

import type pg from "pg";

import {
  antifraudPoolOptions,
  assertAntifraudSessionSettings,
  assertMigrationDatabaseMatchesRuntime,
  isTransientDatabaseStartupError,
  migrationPoolOptions,
  sourceConnectionString,
  sourceSslFor,
} from "../src/db.js";

test("source database TLS is disabled only when explicitly configured", () => {
  assert.equal(sourceSslFor("disable"), false);
});

test("database startup retries failover errors but not integrity failures", () => {
  assert.equal(isTransientDatabaseStartupError({ code: "57P01" }), true);
  assert.equal(isTransientDatabaseStartupError({ code: "08006" }), true);
  assert.equal(isTransientDatabaseStartupError({ code: "08P01" }), false);
  assert.equal(isTransientDatabaseStartupError({ code: "EAI_AGAIN" }), true);
  assert.equal(isTransientDatabaseStartupError({ code: "EHOSTUNREACH" }), true);
  assert.equal(isTransientDatabaseStartupError({ code: "EPIPE" }), true);
  assert.equal(
    isTransientDatabaseStartupError(
      new Error("server login has been failing, cached error: connect failed (server_login_retry)"),
    ),
    true,
  );
  assert.equal(
    isTransientDatabaseStartupError({
      cause: new Error("the database system is shutting down"),
    }),
    true,
  );
  assert.equal(
    isTransientDatabaseStartupError(
      new Error("Antifraud migration database does not match the runtime database identity"),
    ),
    false,
  );
  assert.equal(
    isTransientDatabaseStartupError(new Error("Migration checksum mismatch")),
    false,
  );
  assert.equal(
    isTransientDatabaseStartupError(
      new Error("server login has been failing: password authentication failed"),
    ),
    false,
  );
  assert.equal(
    isTransientDatabaseStartupError(
      new Error("connect failed: self-signed certificate in certificate chain"),
    ),
    false,
  );
});

test("source database require keeps transport encrypted without a private CA", () => {
  assert.deepEqual(sourceSslFor("require"), {
    rejectUnauthorized: false,
  });
});

test("source database verifies a configured private CA", () => {
  assert.deepEqual(sourceSslFor("require", "line-one\\nline-two"), {
    rejectUnauthorized: true,
    ca: "line-one\nline-two",
  });
});

test("source connection strings cannot override the configured TLS policy", () => {
  const base = "postgresql://user:password@example.com:5432/main";

  const disabled = new URL(sourceConnectionString(`${base}?sslmode=require`, "disable"));
  assert.equal(disabled.searchParams.get("sslmode"), "disable");
  assert.equal(disabled.searchParams.has("uselibpqcompat"), false);

  const encrypted = new URL(sourceConnectionString(base, "require"));
  assert.equal(encrypted.searchParams.get("sslmode"), "require");
  assert.equal(encrypted.searchParams.get("uselibpqcompat"), "true");

  const verified = new URL(sourceConnectionString(base, "require", "private-ca"));
  assert.equal(verified.searchParams.get("sslmode"), "verify-full");
  assert.equal(verified.searchParams.has("uselibpqcompat"), false);
});

test("source connection string errors never expose credentials", () => {
  assert.throws(
    () => sourceConnectionString("not-a-database-url-with-secret", "require"),
    { message: "SOURCE_DATABASE_URL is invalid" },
  );
});

test("pooled antifraud runtime sends no unsupported startup options", () => {
  const options = antifraudPoolOptions({
    ANTIFRAUD_DATABASE_URL: "postgresql://pooler/runtime",
    ANTIFRAUD_DATABASE_SSL: "disable",
  });

  assert.equal(options.connectionString, "postgresql://pooler/runtime");
  assert.equal(options.max, 20);
  assert.equal(options.application_name, "packy-antifraud");
  assert.equal(options.options, undefined);
});

test("migration pool is separate, direct, and limited to one connection", () => {
  const options = migrationPoolOptions({
    ANTIFRAUD_MIGRATION_DATABASE_URL: "postgresql://postgres-direct/migrations",
    ANTIFRAUD_DATABASE_SSL: "disable",
  });

  assert.equal(
    options.connectionString,
    "postgresql://postgres-direct/migrations",
  );
  assert.equal(options.max, 1);
  assert.equal(options.application_name, "packy-antifraud-migrations");
  assert.equal(options.options, undefined);
});

test("migration database identity must match the runtime database", async () => {
  const pool = (identity: {
    database_name: string;
    role_name: string;
    system_identifier: string;
  }) =>
    ({ query: async () => ({ rows: [identity] }) }) as unknown as pg.Pool;
  const expected = {
    database_name: "railway",
    role_name: "postgres",
    system_identifier: "123456789",
  };

  await assert.doesNotReject(() =>
    assertMigrationDatabaseMatchesRuntime(pool(expected), pool(expected)),
  );
  await assert.rejects(
    () =>
      assertMigrationDatabaseMatchesRuntime(
        pool(expected),
        pool({ ...expected, system_identifier: "987654321" }),
      ),
    /does not match the runtime database identity/,
  );
});

test("runtime session safeguard verification accepts the required defaults", async () => {
  const pool = {
    query: async () => ({
      rows: [
        { name: "statement_timeout", setting: "15000", unit: "ms" },
        { name: "TimeZone", setting: "UTC", unit: null },
        {
          name: "idle_in_transaction_session_timeout",
          setting: "0",
          unit: "ms",
        },
      ],
    }),
  } as unknown as pg.Pool;

  await assert.doesNotReject(() => assertAntifraudSessionSettings(pool));
});

test("runtime session safeguard verification fails closed on a missing timeout", async () => {
  const pool = {
    query: async () => ({
      rows: [
        { name: "statement_timeout", setting: "0", unit: "ms" },
        { name: "TimeZone", setting: "Etc/UTC", unit: null },
        {
          name: "idle_in_transaction_session_timeout",
          setting: "0",
          unit: "ms",
        },
      ],
    }),
  } as unknown as pg.Pool;

  await assert.rejects(
    () => assertAntifraudSessionSettings(pool),
    /statement_timeout=0ms/,
  );
});

test("runtime session safeguard verification protects the idle leader lease", async () => {
  const pool = {
    query: async () => ({
      rows: [
        { name: "statement_timeout", setting: "15000", unit: "ms" },
        { name: "TimeZone", setting: "UTC", unit: null },
        {
          name: "idle_in_transaction_session_timeout",
          setting: "30000",
          unit: "ms",
        },
      ],
    }),
  } as unknown as pg.Pool;

  await assert.rejects(
    () => assertAntifraudSessionSettings(pool),
    /idle_in_transaction_session_timeout=30000ms/,
  );
});
