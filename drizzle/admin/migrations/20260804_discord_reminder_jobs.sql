CREATE TABLE IF NOT EXISTS "discord_reminder_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "interaction_id" text NOT NULL,
  "guild_id" text NOT NULL,
  "source_channel_id" text NOT NULL,
  "target_channel_id" text NOT NULL,
  "user_id" text NOT NULL,
  "due_at" timestamptz NOT NULL,
  "available_at" timestamptz NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "attempt_count" integer NOT NULL DEFAULT 0,
  "max_attempts" integer NOT NULL DEFAULT 10,
  "lease_token" uuid,
  "lease_owner" text,
  "leased_until" timestamptz,
  "discord_message_id" text,
  "last_error_code" text,
  "last_error_message" text,
  "delivered_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "discord_reminder_jobs_interaction_unique" UNIQUE ("interaction_id"),
  CONSTRAINT "discord_reminder_jobs_interaction_check" CHECK ("interaction_id" ~ '^[0-9]{17,20}$'),
  CONSTRAINT "discord_reminder_jobs_guild_check" CHECK ("guild_id" ~ '^[0-9]{17,20}$'),
  CONSTRAINT "discord_reminder_jobs_source_channel_check" CHECK ("source_channel_id" ~ '^[0-9]{17,20}$'),
  CONSTRAINT "discord_reminder_jobs_target_channel_check" CHECK ("target_channel_id" ~ '^[0-9]{17,20}$'),
  CONSTRAINT "discord_reminder_jobs_user_check" CHECK ("user_id" ~ '^[0-9]{17,20}$'),
  CONSTRAINT "discord_reminder_jobs_attempt_check" CHECK (
    "attempt_count" >= 0 AND "max_attempts" BETWEEN 1 AND 25
  ),
  CONSTRAINT "discord_reminder_jobs_status_check" CHECK (
    "status" IN ('pending', 'leased', 'delivered', 'dead')
  )
);

CREATE INDEX IF NOT EXISTS "discord_reminder_jobs_claim_idx"
  ON "discord_reminder_jobs" ("available_at", "created_at", "id")
  WHERE "status" IN ('pending', 'leased');

CREATE INDEX IF NOT EXISTS "discord_reminder_jobs_history_idx"
  ON "discord_reminder_jobs" ("guild_id", "created_at" DESC);

-- Grant only the deployed PackyGG Rewards Bot key this narrow capability.
-- The prefix is a public identifier and is not credential material.
UPDATE "api_keys"
SET "scopes" = array_append("scopes", 'discord:reminders')
WHERE "prefix" = 'pwa__WZ4VvUngxA4'
  AND "is_active" = true
  AND NOT ('discord:reminders' = ANY("scopes"));
