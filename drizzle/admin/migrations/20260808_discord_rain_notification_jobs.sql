CREATE TABLE IF NOT EXISTS "discord_rain_notification_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "rain_id" uuid NOT NULL,
  "pool_usd_cents" integer NOT NULL,
  "participant_count" integer NOT NULL,
  "starts_at" timestamptz NOT NULL,
  "ends_at" timestamptz NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "attempt_count" integer NOT NULL DEFAULT 0,
  "max_attempts" integer NOT NULL DEFAULT 10,
  "available_at" timestamptz NOT NULL DEFAULT now(),
  "lease_token" uuid,
  "lease_owner" text,
  "leased_until" timestamptz,
  "discord_message_id" text,
  "last_error_code" text,
  "last_error_message" text,
  "delivered_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "discord_rain_notification_jobs_rain_id_key" UNIQUE ("rain_id"),
  CONSTRAINT "discord_rain_notification_jobs_status_check"
    CHECK ("status" IN ('pending', 'leased', 'delivered', 'dead')),
  CONSTRAINT "discord_rain_notification_jobs_attempt_check"
    CHECK ("attempt_count" >= 0 AND "max_attempts" BETWEEN 1 AND 25),
  CONSTRAINT "discord_rain_notification_jobs_pool_check"
    CHECK ("pool_usd_cents" > 2000),
  CONSTRAINT "discord_rain_notification_jobs_participants_check"
    CHECK ("participant_count" >= 0),
  CONSTRAINT "discord_rain_notification_jobs_window_check"
    CHECK ("ends_at" > "starts_at"),
  CONSTRAINT "discord_rain_notification_jobs_lease_shape_check"
    CHECK (
      ("status" = 'leased' AND "lease_token" IS NOT NULL AND "lease_owner" IS NOT NULL AND "leased_until" IS NOT NULL)
      OR
      ("status" <> 'leased' AND "lease_token" IS NULL AND "lease_owner" IS NULL AND "leased_until" IS NULL)
    ),
  CONSTRAINT "discord_rain_notification_jobs_message_id_check"
    CHECK ("discord_message_id" IS NULL OR "discord_message_id" ~ '^[0-9]{17,20}$')
);

CREATE INDEX IF NOT EXISTS "discord_rain_notification_jobs_claim_idx"
  ON "discord_rain_notification_jobs" ("available_at", "created_at", "id")
  WHERE "status" IN ('pending', 'leased');

-- The Rewards Bot is the sole consumer of this queue. The prefix is a public
-- identifier, not credential material.
UPDATE "api_keys"
SET "scopes" = array_append("scopes", 'discord:rains')
WHERE "prefix" = 'pwa__WZ4VvUngxA4'
  AND "is_active" = true
  AND NOT ('discord:rains' = ANY("scopes"));
