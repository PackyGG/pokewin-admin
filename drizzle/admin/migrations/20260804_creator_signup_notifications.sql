-- Creator activity notifications default on for new and never-configured
-- sections. Explicit creator opt-outs remain disabled.
ALTER TABLE "discord_creator_setups"
  ALTER COLUMN "deposit_notifications_enabled" SET DEFAULT true,
  ALTER COLUMN "deposit_notifications_enabled_at" SET DEFAULT now();

UPDATE "discord_creator_setups"
SET
  "deposit_notifications_enabled" = true,
  "deposit_notifications_enabled_at" = COALESCE(
    "deposit_notifications_enabled_at",
    now()
  )
WHERE "deposit_notifications_updated_at" IS NULL;

CREATE TABLE IF NOT EXISTS "discord_creator_signup_scan_state" (
  "singleton_id" SMALLINT PRIMARY KEY DEFAULT 1,
  "scan_through_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "lease_token" UUID,
  "lease_owner" TEXT,
  "leased_until" TIMESTAMPTZ(6),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "discord_creator_signup_scan_singleton_check"
    CHECK ("singleton_id" = 1),
  CONSTRAINT "discord_creator_signup_scan_lease_shape_check"
    CHECK (
      ("lease_token" IS NULL AND "lease_owner" IS NULL AND "leased_until" IS NULL)
      OR
      ("lease_token" IS NOT NULL AND "lease_owner" IS NOT NULL AND "leased_until" IS NOT NULL)
    )
);

INSERT INTO "discord_creator_signup_scan_state" ("singleton_id")
VALUES (1)
ON CONFLICT ("singleton_id") DO NOTHING;

CREATE TABLE IF NOT EXISTS "discord_creator_signup_jobs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "setup_id" UUID NOT NULL REFERENCES "discord_creator_setups"("id") ON DELETE CASCADE,
  "source_signup_id" UUID NOT NULL,
  "creator_user_id" TEXT NOT NULL,
  "referred_user_id" TEXT NOT NULL,
  "referred_username" TEXT,
  "affiliate_code" TEXT NOT NULL,
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
  CONSTRAINT "discord_creator_signup_jobs_source_unique" UNIQUE ("source_signup_id"),
  CONSTRAINT "discord_creator_signup_jobs_attempt_check"
    CHECK ("attempt_count" >= 0 AND "max_attempts" BETWEEN 1 AND 25),
  CONSTRAINT "discord_creator_signup_jobs_status_check"
    CHECK ("status" IN ('pending', 'leased', 'delivered', 'dead'))
);

CREATE INDEX IF NOT EXISTS "discord_creator_signup_jobs_claim_idx"
  ON "discord_creator_signup_jobs" ("available_at", "created_at", "id")
  WHERE "status" IN ('pending', 'leased');

CREATE INDEX IF NOT EXISTS "discord_creator_signup_jobs_setup_history_idx"
  ON "discord_creator_signup_jobs" ("setup_id", "created_at" DESC);
