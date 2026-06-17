import "server-only";

import { adminDb } from "@/lib/admin-db";

// Module-level flag so the CREATE runs at most once per server process.
// Reset to false on failure so the next caller retries.
let ensured = false;

/**
 * Create the `pack_set_assignments` table + index if missing — the same
 * self-heal pattern used by /changelogs, /salaries, /shifts and the
 * employee board. There is deliberately NO Prisma migration file: the
 * admin DB has a drifted migration history, so new admin-panel tables are
 * provisioned via this runtime IF-NOT-EXISTS fallback. The Prisma schema
 * mirrors the table so typed `adminDb.pack_set_assignments.*` queries work.
 *
 * IF NOT EXISTS makes every statement idempotent; concurrent first callers
 * race-safely on the ACCESS EXCLUSIVE lock PG takes around CREATE.
 *
 * Schema mirror — keep in sync with prisma/admin/schema.prisma:
 *   - pack_id         UUID PK (packy.gg packs.id)
 *   - pack_set        TEXT NOT NULL ('pokemon'|'onepiece'|'meme'|'rewards')
 *   - set_by_admin_id UUID NULL (loose FK → admin_users.id)
 *   - created_at, updated_at TIMESTAMPTZ NOT NULL defaults
 */
export async function ensurePackSetAssignmentsSchema(): Promise<void> {
  if (ensured) return;
  try {
    await adminDb.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "pack_set_assignments" (
        "pack_id"         UUID PRIMARY KEY,
        "pack_set"        TEXT NOT NULL,
        "set_by_admin_id" UUID,
        "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
        "updated_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now()
      )
    `);
    await adminDb.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "pack_set_assignments_pack_set_idx"
        ON "pack_set_assignments" ("pack_set")
    `);
    ensured = true;
  } catch (err) {
    ensured = false;
    throw err;
  }
}
