#!/usr/bin/env node

import "dotenv/config";

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import pg from "pg";

const relativeFile = process.argv[2];
if (!relativeFile || process.argv.length !== 3) {
  throw new Error(
    "Usage: npm run admin:sql -- <path-to-reviewed-admin-migration.sql>",
  );
}

const connectionString = process.env.ADMIN_DATABASE_URL?.trim();
if (!connectionString) {
  throw new Error("ADMIN_DATABASE_URL is required");
}
if (
  [process.env.DATABASE_URL, process.env.DATABASE_URL_POOLED]
    .flatMap((value) => (value ? [value.trim()] : []))
    .includes(connectionString)
) {
  throw new Error(
    "Refusing to run: ADMIN_DATABASE_URL matches the read-only MAIN DATABASE_URL",
  );
}

const workspaceRoot = process.cwd();
const migrationPath = path.resolve(workspaceRoot, relativeFile);
const relativeMigrationPath = path.relative(workspaceRoot, migrationPath);
const migrationsRoot = path.resolve(
  workspaceRoot,
  "drizzle",
  "admin",
  "migrations",
);
if (
  path.dirname(migrationPath) !== migrationsRoot ||
  path.extname(migrationPath).toLowerCase() !== ".sql"
) {
  throw new Error(
    "Migration must be a .sql file directly under drizzle/admin/migrations",
  );
}

const migrationSql = await readFile(migrationPath, "utf8");
if (migrationSql.trim().length === 0) {
  throw new Error("Migration SQL is empty");
}
if (migrationSql.charCodeAt(0) === 0xfeff) {
  throw new Error("Migration SQL must be UTF-8 without a byte-order mark");
}
if (/^\s*(?:COMMIT|ROLLBACK)(?:\s+WORK)?\s*;/im.test(migrationSql)) {
  throw new Error("Migration SQL must not control its wrapper transaction");
}

const client = new pg.Client({
  connectionString,
  application_name: "pokewin-admin-migrate",
  connectionTimeoutMillis: 10_000,
  keepAlive: true,
});
await client.connect();

try {
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout = '10s'");
  await client.query("SET LOCAL statement_timeout = '120s'");
  await client.query("SELECT pg_advisory_xact_lock($1)", [1_729_264_536]);
  await client.query(migrationSql);
  await client.query("COMMIT");
  console.log(`Applied admin migration: ${relativeMigrationPath}`);
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
