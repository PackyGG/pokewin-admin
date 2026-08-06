-- Post an approved creator VIP reward claim (FTD lossback, wager milestone,
-- ...) into the creator's Discord logs channel, alongside the existing
-- sign-up and deposit notifications. Always-on like sign-ups (no per-creator
-- toggle) — the approval action inserts a row directly, no discovery scan is
-- needed since approval already happens inside this app.

CREATE TABLE IF NOT EXISTS "discord_creator_reward_claim_jobs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "setup_id" UUID NOT NULL REFERENCES "discord_creator_setups"("id") ON DELETE CASCADE,
  "source_claim_id" UUID NOT NULL,
  "creator_user_id" TEXT NOT NULL,
  "referred_user_id" TEXT NOT NULL,
  "referred_username" TEXT,
  "leg" TEXT NOT NULL,
  "program_name" TEXT NOT NULL,
  "amount_usd" NUMERIC(20, 2) NOT NULL,
  "units" INTEGER NOT NULL DEFAULT 0,
  "occurred_at" TIMESTAMPTZ(6) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 8,
  "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "lease_token" UUID,
  "lease_owner" TEXT,
  "leased_until" TIMESTAMPTZ(6),
  "discord_message_id" TEXT,
  "last_error_code" TEXT,
  "last_error_message" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "delivered_at" TIMESTAMPTZ(6),
  CONSTRAINT "discord_creator_reward_claim_jobs_source_unique"
    UNIQUE ("source_claim_id"),
  CONSTRAINT "discord_creator_reward_claim_jobs_amount_check"
    CHECK ("amount_usd" > 0 AND "units" >= 0),
  CONSTRAINT "discord_creator_reward_claim_jobs_leg_check"
    CHECK ("leg" <> ''),
  CONSTRAINT "discord_creator_reward_claim_jobs_attempt_check"
    CHECK ("attempt_count" >= 0 AND "max_attempts" BETWEEN 1 AND 25),
  CONSTRAINT "discord_creator_reward_claim_jobs_status_check"
    CHECK ("status" IN ('pending', 'leased', 'delivered', 'dead'))
);

CREATE INDEX IF NOT EXISTS "discord_creator_reward_claim_jobs_claim_idx"
  ON "discord_creator_reward_claim_jobs" ("available_at", "created_at", "id")
  WHERE "status" IN ('pending', 'leased');

CREATE INDEX IF NOT EXISTS "discord_creator_reward_claim_jobs_setup_history_idx"
  ON "discord_creator_reward_claim_jobs" ("setup_id", "created_at" DESC);
