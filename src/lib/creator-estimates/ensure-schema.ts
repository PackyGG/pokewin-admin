import "server-only";

import { adminDb } from "@/lib/admin-db";

// Module-level flag so we only run the CREATE statements once per
// server process. Reset to false on failure so the next caller retries.
let ensured = false;

/**
 * Create the creator_deal_estimates table + indexes if they're missing,
 * AND upgrade v1 envs to the v2 schema (drop cadence/fill/tip/free-battle
 * columns, add daily_fill / leaderboard / deal_length columns).
 *
 * Same self-heal pattern used by /shifts and /salaries — defensive
 * runtime fallback for environments where the migrations at
 * prisma/admin/migrations/20260507000000_creator_deal_estimates and
 * 20260507100000_creator_deal_estimates_v2 haven't been applied yet.
 *
 * IF NOT EXISTS / IF EXISTS makes every statement idempotent.
 */
export async function ensureCreatorEstimatesSchema(): Promise<void> {
  if (ensured) return;
  try {
    // Base table — v1 shape kept on the CREATE so a fresh env that
    // has never seen this table still ends up with the right
    // columns. The ALTERs below converge it to v2.
    await adminDb.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "creator_deal_estimates" (
        "id"                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "name"                TEXT NOT NULL,
        "withdrawal_cap_usd"  NUMERIC(20, 2),
        "withdrawal_percent"  NUMERIC(5, 2),
        "notes"               TEXT,
        "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
        "updated_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
        "created_by_id"       UUID NOT NULL REFERENCES "admin_users"("id")
      )
    `);
    // v1 → v2 cleanup: drop columns the new model doesn't use.
    await adminDb.$executeRawUnsafe(`
      DROP INDEX IF EXISTS "creator_deal_estimates_cadence_idx"
    `);
    await adminDb.$executeRawUnsafe(`
      ALTER TABLE "creator_deal_estimates"
        DROP COLUMN IF EXISTS "cadence",
        DROP COLUMN IF EXISTS "fill_amount_usd",
        DROP COLUMN IF EXISTS "fill_percent",
        DROP COLUMN IF EXISTS "tip_cap_usd",
        DROP COLUMN IF EXISTS "free_battle_cap_usd"
    `);
    // v2 column adds.
    await adminDb.$executeRawUnsafe(`
      ALTER TABLE "creator_deal_estimates"
        ADD COLUMN IF NOT EXISTS "daily_fill_usd"       NUMERIC(20, 2),
        ADD COLUMN IF NOT EXISTS "leaderboard_cost_usd" NUMERIC(20, 2),
        ADD COLUMN IF NOT EXISTS "packy_paid_percent"   NUMERIC(5, 2),
        ADD COLUMN IF NOT EXISTS "deal_length_weeks"    INTEGER
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
