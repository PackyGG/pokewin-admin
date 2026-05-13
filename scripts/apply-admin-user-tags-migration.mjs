#!/usr/bin/env node
// One-shot migration runner for the admin DB's `admin_user_tags`
// table. We don't go through `prisma migrate deploy` here because the
// admin-schema config path is broken on this Prisma version (it
// double-resolves "prisma/admin/..." against the config dir). Instead
// we:
//   1. Connect with the pg driver using ADMIN_DATABASE_URL
//   2. Run the migration SQL directly (idempotent — uses IF NOT EXISTS
//      via the CREATE TABLE pattern surrounding the CHECK + indexes)
//   3. Insert a row into `_prisma_migrations` so future
//      `prisma migrate deploy` calls don't try to re-apply it
//
// Safe to run twice — both the SQL and the `_prisma_migrations` insert
// are guarded.
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_NAME = "20260513000000_admin_user_tags";
const SQL_PATH = join(
  __dirname,
  "..",
  "prisma",
  "admin",
  "migrations",
  MIGRATION_NAME,
  "migration.sql",
);

const url = process.env.ADMIN_DATABASE_URL;
if (!url) {
  console.error("ADMIN_DATABASE_URL is not set. Aborting.");
  process.exit(1);
}

const sql = await readFile(SQL_PATH, "utf8");
// Prisma stores a sha256 of the migration SQL in _prisma_migrations
// so it can detect drift. We compute the same hash for our manual
// insert.
const checksum = createHash("sha256").update(sql).digest("hex");

const client = new pg.Client({ connectionString: url });
await client.connect();

try {
  // Check if the table already exists — if so, the SQL is already
  // applied (probably manually) and we just need to record the
  // migration entry.
  const tableExistsRes = await client.query(
    `SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'admin_user_tags' LIMIT 1`,
  );
  const tableExists = tableExistsRes.rowCount > 0;

  if (!tableExists) {
    console.log(`Applying SQL from ${MIGRATION_NAME}...`);
    await client.query(sql);
    console.log("  ✔ SQL applied");
  } else {
    console.log(
      `Table admin_user_tags already exists — skipping SQL, just recording migration.`,
    );
  }

  // Make sure the _prisma_migrations table itself exists. It always
  // does on a normal Prisma-managed DB, but be defensive in case
  // someone wiped it.
  await client.query(`
    CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
      "id" VARCHAR(36) PRIMARY KEY,
      "checksum" VARCHAR(64) NOT NULL,
      "finished_at" TIMESTAMP WITH TIME ZONE,
      "migration_name" VARCHAR(255) NOT NULL,
      "logs" TEXT,
      "rolled_back_at" TIMESTAMP WITH TIME ZONE,
      "started_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "applied_steps_count" INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Idempotent insert — skip if a row for this migration_name already
  // exists. Random UUID for `id`; Prisma doesn't use it elsewhere.
  const inserted = await client.query(
    `INSERT INTO "_prisma_migrations"
      (id, checksum, finished_at, migration_name, started_at, applied_steps_count)
     VALUES (gen_random_uuid()::text, $1, NOW(), $2, NOW(), 1)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [checksum, MIGRATION_NAME],
  );
  // _prisma_migrations has no unique constraint on migration_name by
  // default (Prisma deduplicates app-side), so we manually check.
  const existingRes = await client.query(
    `SELECT id FROM "_prisma_migrations" WHERE migration_name = $1 LIMIT 1`,
    [MIGRATION_NAME],
  );
  if (existingRes.rowCount > 1) {
    // Clean up any duplicate rows from a prior failed run — keep one.
    await client.query(
      `DELETE FROM "_prisma_migrations" WHERE migration_name = $1
       AND id NOT IN (SELECT MIN(id::text)::varchar FROM "_prisma_migrations" WHERE migration_name = $1)`,
      [MIGRATION_NAME],
    );
  }
  console.log(
    inserted.rowCount > 0
      ? `  ✔ Recorded migration ${MIGRATION_NAME}`
      : `  • Migration ${MIGRATION_NAME} already recorded`,
  );

  console.log("\nDone.");
} catch (err) {
  console.error("Migration failed:", err);
  process.exitCode = 1;
} finally {
  await client.end();
}
