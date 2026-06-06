-- Restore prod-only drift objects accidentally dropped by db push.
-- Idempotent — safe to re-run.

-- creator_deals cashout limits (legacy columns, not in Prisma schema)
ALTER TABLE "creator_deals"
  ADD COLUMN IF NOT EXISTS "monthly_cashout_limit" NUMERIC(20, 2);

ALTER TABLE "creator_deals"
  ADD COLUMN IF NOT EXISTS "weekly_cashout_limit" NUMERIC(20, 2);

-- creator_deal_estimates (final v3 shape after all estimate migrations)
CREATE TABLE IF NOT EXISTS "creator_deal_estimates" (
  "id"                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"                TEXT NOT NULL,
  "withdrawal_cap_usd"  NUMERIC(20, 2),
  "withdrawal_percent"  NUMERIC(5, 2),
  "notes"               TEXT,
  "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "created_by_id"       UUID NOT NULL REFERENCES "admin_users"("id"),
  "daily_fill_usd"       NUMERIC(20, 2),
  "leaderboard_cost_usd" NUMERIC(20, 2),
  "packy_paid_percent"   NUMERIC(5, 2),
  "deal_length_weeks"    INTEGER,
  "tip_balance_usd"      NUMERIC(20, 2),
  "battle_balance_usd"   NUMERIC(20, 2),
  "video_amount_usd"     NUMERIC(20, 2),
  "video_percent"        NUMERIC(5, 2),
  "video_fills_per_week" INTEGER
);

CREATE INDEX IF NOT EXISTS "creator_deal_estimates_created_at_idx"
  ON "creator_deal_estimates" ("created_at" DESC);
