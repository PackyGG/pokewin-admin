-- Creator deal estimates — admin-only scratchpad for tracking
-- prospective creator deals BEFORE they exist as real accounts.
-- Decoupled from admin_users / creator_deals; pure planning table.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, indexes too. The runtime
-- self-heal in src/lib/creator-estimates/ensure-schema.ts mirrors
-- this so envs that haven't applied the migration still work.

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
);

CREATE INDEX IF NOT EXISTS "creator_deal_estimates_cadence_idx"
  ON "creator_deal_estimates" ("cadence");

CREATE INDEX IF NOT EXISTS "creator_deal_estimates_created_at_idx"
  ON "creator_deal_estimates" ("created_at" DESC);
