import "server-only";

import { adminDb } from "@/lib/admin-db";

// Module-level flag so we only run the CREATE statements once per server
// process. Reset to false on failure so the next caller retries.
let ensured = false;

/**
 * Create the `admin_balance_adjustment_meta` table + indexes if they're
 * missing — the same self-heal pattern used by /salaries, /shifts,
 * the employee board, and the changelog.
 *
 * WHY an ensure-schema table instead of a migration: the admin DB has a
 * drifted migration history (the user lived through a `migrate dev`
 * disaster), so new admin-panel tables are provisioned via this runtime
 * IF-NOT-EXISTS fallback instead of a migration that could conflict or
 * want to reset the prod admin DB. The Prisma schema mirrors the table so
 * typed `adminDb.admin_balance_adjustment_meta.*` queries still work.
 *
 * IF NOT EXISTS makes every statement idempotent. Concurrent first callers
 * race-safely on the ACCESS EXCLUSIVE lock PG takes around CREATE TABLE /
 * CREATE INDEX.
 *
 * WHAT it stores: the RICH, admin-only metadata for a strict categorized
 * balance adjustment. The canonical CATEGORY KEY also lives on the main-DB
 * ledger row (`metadata.adjustment_category`) — that is what the GGR/cost
 * queries read with NO cross-DB join. THIS admin table is the audit/detail
 * companion: the category-specific inputs (coin type, tx hash, social
 * link, exact reason, lossback %, 7d PnL, free-text explanation) that only
 * make sense in the admin panel and never need to be in the main DB.
 *
 * Schema mirror — keep in sync with prisma/admin/schema.prisma
 * (model admin_balance_adjustment_meta):
 *   - id              UUID PK
 *   - admin_user_id   VARCHAR(36) NOT NULL  (admin_users.id, loose)
 *   - target_user_id  VARCHAR(36) NOT NULL  (main-DB user id)
 *   - ledger_tx_id    VARCHAR(36) NOT NULL  (main-DB ledger row id, loose FK)
 *   - category        VARCHAR(40) NOT NULL  (canonical category key)
 *   - amount_usd      NUMERIC(20,2) NOT NULL (signed; mirrors ledger amount)
 *   - coin_type       VARCHAR(64)  NULL  (deposit_problem)
 *   - tx_hash         VARCHAR(255) NULL  (deposit_problem)
 *   - social_link     VARCHAR(2048) NULL (giveaway)
 *   - reason_text     TEXT         NULL  (bonus exact reason / lossback note)
 *   - lossback_pct    NUMERIC(7,2) NULL  (lossback)
 *   - pnl_7d_usd      NUMERIC(20,2) NULL (lossback)
 *   - created_at      TIMESTAMP(6) NOT NULL default now()
 *
 * Indexes: target_user_id (per-user listing), created_at DESC (recent-first
 * feed), ledger_tx_id (cross-reference back from a ledger row), category
 * (per-category audit filter).
 *
 * admin_user_id is intentionally NOT a real FK to admin_users — the same
 * loose-column convention used by admin_balance_adjustment_wipes.wiped_by —
 * so this table can be added without any change to the admin_users model.
 */
export async function ensureBalanceAdjustmentMetaSchema(): Promise<void> {
  if (ensured) return;
  try {
    await adminDb.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "admin_balance_adjustment_meta" (
        "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "admin_user_id"  VARCHAR(36) NOT NULL,
        "target_user_id" VARCHAR(36) NOT NULL,
        "ledger_tx_id"   VARCHAR(36) NOT NULL,
        "category"       VARCHAR(40) NOT NULL,
        "amount_usd"     NUMERIC(20, 2) NOT NULL,
        "coin_type"      VARCHAR(64),
        "tx_hash"        VARCHAR(255),
        "social_link"    VARCHAR(2048),
        "reason_text"    TEXT,
        "lossback_pct"   NUMERIC(7, 2),
        "pnl_7d_usd"     NUMERIC(20, 2),
        "created_at"     TIMESTAMP(6) NOT NULL DEFAULT now()
      )
    `);
    await adminDb.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "admin_balance_adjustment_meta_target_user_id_idx"
        ON "admin_balance_adjustment_meta" ("target_user_id")
    `);
    await adminDb.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "admin_balance_adjustment_meta_created_at_idx"
        ON "admin_balance_adjustment_meta" ("created_at" DESC)
    `);
    await adminDb.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "admin_balance_adjustment_meta_ledger_tx_id_idx"
        ON "admin_balance_adjustment_meta" ("ledger_tx_id")
    `);
    await adminDb.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "admin_balance_adjustment_meta_category_idx"
        ON "admin_balance_adjustment_meta" ("category")
    `);
    ensured = true;
  } catch (err) {
    // Reset so the next call retries. Re-throw so the caller can
    // distinguish "schema setup failed" from "data missing".
    ensured = false;
    throw err;
  }
}
