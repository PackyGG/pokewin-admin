import "server-only";

import { adminDb } from "@/lib/admin-db";

// Module-level flag so we only run the CREATE statements once per server
// process. Reset to false on failure so the next caller retries.
let ensured = false;

/**
 * Create the `admin_account_wipes` table + indexes if they're missing —
 * the SAME self-heal pattern used by the adjustments-wipe store
 * (src/lib/balance-adjustment-wipes/ensure-schema.ts), /salaries, /shifts,
 * the employee board, and the changelog.
 *
 * This is the GENERALIZED recovery store for the three new wipe targets —
 * "balance", "vault", "inventory" — added alongside the original
 * adjustments wipe. One table keyed by `wipe_type` (rather than three
 * per-type tables) keeps the audit-log + restore code uniform; the
 * type-specific recovery payload lives in the `snapshot` JSONB.
 *
 * There is deliberately NO Prisma migration file for this table: the admin
 * DB has a drifted migration history (the user has lived through a
 * `migrate dev` disaster), so new admin-panel tables are provisioned via
 * this runtime IF-NOT-EXISTS fallback instead of a migration that could
 * conflict or want to reset the prod admin DB. The Prisma schema mirrors
 * the table so typed queries via `adminDb.admin_account_wipes.*` still work.
 *
 * IF NOT EXISTS makes every statement idempotent. Concurrent first callers
 * race-safely on the ACCESS EXCLUSIVE lock PG takes around CREATE TABLE /
 * CREATE INDEX.
 *
 * Schema mirror — keep in sync with prisma/admin/schema.prisma
 * (model admin_account_wipes):
 *   - id               UUID PK (wipe id)
 *   - wipe_type        VARCHAR(32) NOT NULL  ('balance' | 'vault' | 'inventory')
 *   - user_id          VARCHAR(36) NOT NULL  (main-DB user id)
 *   - username         VARCHAR(255) NULL
 *   - email            VARCHAR(255) NULL
 *   - wiped_at         TIMESTAMP(6) NOT NULL default now()
 *   - wiped_by         VARCHAR(36) NOT NULL  (admin_users.id, loose column)
 *   - amount           NUMERIC(20,2) NOT NULL  (money removed; 0 for inventory)
 *   - item_count       INT NOT NULL DEFAULT 0  (rows removed; 0 for balance/vault)
 *   - snapshot         JSONB NOT NULL  (type-specific recovery payload)
 *   - restored_at      TIMESTAMP(6) NULL
 *   - restored_by      VARCHAR(36) NULL
 *
 * Indexes: user_id (per-user listing), wiped_at DESC (recent-first feed).
 *
 * wiped_by / restored_by are intentionally NOT real FKs to admin_users —
 * same loose-column convention used by admin_balance_adjustment_wipes and
 * admin_deleted_users — so this table can be added without any change to
 * the admin_users model.
 */
export async function ensureAccountWipesSchema(): Promise<void> {
  if (ensured) return;
  try {
    await adminDb.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "admin_account_wipes" (
        "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "wipe_type"   VARCHAR(32) NOT NULL,
        "user_id"     VARCHAR(36) NOT NULL,
        "username"    VARCHAR(255),
        "email"       VARCHAR(255),
        "wiped_at"    TIMESTAMP(6) NOT NULL DEFAULT now(),
        "wiped_by"    VARCHAR(36) NOT NULL,
        "amount"      NUMERIC(20, 2) NOT NULL DEFAULT 0,
        "item_count"  INTEGER NOT NULL DEFAULT 0,
        "snapshot"    JSONB NOT NULL,
        "restored_at" TIMESTAMP(6),
        "restored_by" VARCHAR(36)
      )
    `);
    await adminDb.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "admin_account_wipes_user_id_idx"
        ON "admin_account_wipes" ("user_id")
    `);
    await adminDb.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "admin_account_wipes_wiped_at_idx"
        ON "admin_account_wipes" ("wiped_at" DESC)
    `);
    ensured = true;
  } catch (err) {
    // Reset so the next call retries. Re-throw so the caller can
    // distinguish "schema setup failed" from "data missing".
    ensured = false;
    throw err;
  }
}
