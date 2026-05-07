import "server-only";

import { adminDb } from "@/lib/admin-db";

// Module-level flag so we only run the CREATE statements once per
// server process. Reset to false on failure so the next caller retries.
let ensured = false;

/**
 * Create the creator_deal_estimates table + indexes if they're missing.
 * Same self-heal pattern used by /shifts and /salaries — defensive
 * runtime fallback for environments where the migration at
 * prisma/admin/migrations/20260507000000_creator_deal_estimates hasn't
 * been applied yet.
 *
 * IF NOT EXISTS makes every statement idempotent. Concurrent first
 * callers race-safely on the ACCESS EXCLUSIVE locks PG takes around
 * CREATE TABLE / CREATE INDEX.
 */
export async function ensureCreatorEstimatesSchema(): Promise<void> {
  if (ensured) return;
  try {
    await adminDb.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "creator_deal_estimates" (
        "id"                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "name"                TEXT NOT NULL,
        "cadence"             TEXT NOT NULL DEFAULT 'monthly',
        "fill_amount_usd"     NUMERIC(20, 2),
        "fill_percent"        NUMERIC(5, 2),
        "withdrawal_cap_usd"  NUMERIC(20, 2),
        "withdrawal_percent"  NUMERIC(5, 2),
        "tip_cap_usd"         NUMERIC(20, 2),
        "free_battle_cap_usd" NUMERIC(20, 2),
        "notes"               TEXT,
        "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
        "updated_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
        "created_by_id"       UUID NOT NULL REFERENCES "admin_users"("id")
      )
    `);
    await adminDb.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "creator_deal_estimates_cadence_idx"
        ON "creator_deal_estimates" ("cadence")
    `);
    await adminDb.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "creator_deal_estimates_created_at_idx"
        ON "creator_deal_estimates" ("created_at" DESC)
    `);
    ensured = true;
  } catch (err) {
    ensured = false;
    throw err;
  }
}
