import "server-only";

import { adminDb } from "@/lib/admin-db";

// Module-level flag so we only run the CREATE statements once per server
// process. Reset to false on failure so the next caller retries.
let ensured = false;

/**
 * Create the admin_balance_adjustment_wipes table + indexes if they're
 * missing — the same self-heal pattern used by /salaries, /shifts, the
 * employee board, and the changelog (see
 * src/lib/changelog/ensure-schema.ts).
 *
 * There is deliberately NO Prisma migration file for this table: the admin
 * DB has a drifted migration history (the user has lived through a
 * `migrate dev` disaster), so new admin-panel tables are provisioned via
 * this runtime IF-NOT-EXISTS fallback instead of a migration that could
 * conflict or want to reset the prod admin DB. The Prisma schema mirrors
 * the table so typed queries via `adminDb.admin_balance_adjustment_wipes.*`
 * still work.
 *
 * IF NOT EXISTS makes every statement idempotent. Concurrent first callers
 * race-safely on the ACCESS EXCLUSIVE lock PG takes around CREATE TABLE /
 * CREATE INDEX.
 *
 * Schema mirror — keep in sync with prisma/admin/schema.prisma
 * (model admin_balance_adjustment_wipes):
 *   - id               UUID PK (wipe-batch id)
 *   - user_id          VARCHAR(36) NOT NULL  (main-DB user id)
 *   - username         VARCHAR(255) NULL
 *   - email            VARCHAR(255) NULL
 *   - wiped_at         TIMESTAMP(6) NOT NULL default now()
 *   - wiped_by         VARCHAR(36) NOT NULL  (admin_users.id, loose)
 *   - total_amount     NUMERIC(20,2) NOT NULL (signed sum of deleted rows)
 *   - balance_before   NUMERIC(20,2) NOT NULL
 *   - balance_after    NUMERIC(20,2) NOT NULL
 *   - adjustment_count INT NOT NULL
 *   - snapshot         JSONB NOT NULL ({ userId, rows: ledger rows[] })
 *   - restored_at      TIMESTAMP(6) NULL
 *   - restored_by      VARCHAR(36) NULL
 *
 * Indexes: user_id (per-user listing), wiped_at DESC (recent-first feed).
 *
 * wiped_by / restored_by are intentionally NOT real FKs to admin_users —
 * same loose-column convention used by admin_deleted_users.deleted_by — so
 * this table can be added without any change to the admin_users model.
 */
export async function ensureBalanceAdjustmentWipesSchema(): Promise<void> {
  if (ensured) return;
  try {
    await adminDb.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "admin_balance_adjustment_wipes" (
        "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "user_id"          VARCHAR(36) NOT NULL,
        "username"         VARCHAR(255),
        "email"            VARCHAR(255),
        "wiped_at"         TIMESTAMP(6) NOT NULL DEFAULT now(),
        "wiped_by"         VARCHAR(36) NOT NULL,
        "total_amount"     NUMERIC(20, 2) NOT NULL,
        "balance_before"   NUMERIC(20, 2) NOT NULL,
        "balance_after"    NUMERIC(20, 2) NOT NULL,
        "adjustment_count" INTEGER NOT NULL,
        "snapshot"         JSONB NOT NULL,
        "restored_at"      TIMESTAMP(6),
        "restored_by"      VARCHAR(36)
      )
    `);
    await adminDb.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "admin_balance_adjustment_wipes_user_id_idx"
        ON "admin_balance_adjustment_wipes" ("user_id")
    `);
    await adminDb.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "admin_balance_adjustment_wipes_wiped_at_idx"
        ON "admin_balance_adjustment_wipes" ("wiped_at" DESC)
    `);
    ensured = true;
  } catch (err) {
    // Reset so the next call retries. Re-throw so the caller can
    // distinguish "schema setup failed" from "data missing".
    ensured = false;
    throw err;
  }
}
