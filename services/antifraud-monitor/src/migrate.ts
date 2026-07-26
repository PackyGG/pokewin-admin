import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
// `dist/src/migrate.js` and `src/migrate.ts` sit at different depths, so the
// compiled and the tsx/dev layouts resolve the same directory differently.
const migrationDirCandidates = [
  join(here, "..", "..", "migrations"),
  join(here, "..", "migrations"),
];

async function resolveMigrations(): Promise<{ dir: string; files: string[] }> {
  for (const dir of migrationDirCandidates) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    const files = entries.filter((name) => /^\d+.*\.sql$/.test(name)).sort();
    if (files.length > 0) return { dir, files };
  }
  throw new Error(
    `Unable to locate the antifraud migrations directory (looked in ${migrationDirCandidates.join(", ")})`,
  );
}

export async function migrate(pool: pg.Pool): Promise<void> {
  const { dir: migrationsDir, files } = await resolveMigrations();

  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [841_772_991]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    for (const file of files) {
      const exists = await client.query<{ exists: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = $1) AS exists",
        [file],
      );
      if (exists.rows[0]?.exists) continue;

      await client.query("BEGIN");
      try {
        await client.query(await readFile(join(migrationsDir, file), "utf8"));
        await client.query(
          "INSERT INTO schema_migrations(version) VALUES ($1)",
          [file],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [841_772_991]);
    client.release();
  }
}
