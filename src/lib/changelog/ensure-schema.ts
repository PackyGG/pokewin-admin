import "server-only";

import { adminDb } from "@/lib/admin-db";

// Module-level flag so we only run the CREATE statements once per
// server process. Reset to false on failure so the next caller retries.
let ensured = false;

/**
 * Create the admin_changelog_entries table + index if they're missing —
 * the same self-heal pattern used by /salaries, /shifts, and the
 * employee board.
 *
 * There is deliberately NO Prisma migration file for this table: the
 * admin DB has a drifted migration history (the user has lived through
 * a `migrate dev` disaster), so new admin-panel tables are provisioned
 * via this runtime IF-NOT-EXISTS fallback instead of a migration that
 * could conflict. The Prisma schema mirrors the table so typed queries
 * via `adminDb.admin_changelog_entries.*` still work.
 *
 * IF NOT EXISTS makes every statement idempotent. Concurrent first
 * callers race-safely on the ACCESS EXCLUSIVE lock PG takes around
 * CREATE TABLE / CREATE INDEX.
 *
 * Schema mirror — keep in sync with prisma/admin/schema.prisma:
 *   - id                    UUID PK
 *   - published_at          TIMESTAMPTZ NOT NULL (admin-set release date)
 *   - title                 TEXT NOT NULL (short headline)
 *   - summary               TEXT NOT NULL (one-paragraph TL;DR)
 *   - version               TEXT NULL (e.g. "v2025.11")
 *   - category              TEXT NOT NULL ('feature' | 'fix' |
 *                           'improvement' | 'breaking' | 'infra')
 *   - changes               JSONB NOT NULL (array of { kind, text })
 *   - author_admin_user_id  UUID NULL (loose FK → admin_users.id)
 *   - created_at, updated_at TIMESTAMPTZ NOT NULL defaults
 *
 * Index: published_at DESC for the feed query (newest first).
 *
 * Author is intentionally NOT a real FK to admin_users — same loose-
 * column convention used by salary_payments / employee_managers /
 * admin_leaderboard_sponsorship — so this table can be added without
 * any change to the admin_users model.
 */
export async function ensureChangelogSchema(): Promise<void> {
  if (ensured) return;
  try {
    await adminDb.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "admin_changelog_entries" (
        "id"                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "published_at"         TIMESTAMPTZ(6) NOT NULL,
        "title"                TEXT NOT NULL,
        "summary"              TEXT NOT NULL,
        "version"              TEXT,
        "category"             TEXT NOT NULL,
        "changes"              JSONB NOT NULL DEFAULT '[]'::jsonb,
        "author_admin_user_id" UUID,
        "created_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
        "updated_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT now()
      )
    `);
    await adminDb.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "admin_changelog_entries_published_at_idx"
        ON "admin_changelog_entries" ("published_at" DESC)
    `);
    ensured = true;
  } catch (err) {
    // Reset so the next call retries. Re-throw so the caller can
    // distinguish "schema setup failed" from "data missing".
    ensured = false;
    throw err;
  }
}
