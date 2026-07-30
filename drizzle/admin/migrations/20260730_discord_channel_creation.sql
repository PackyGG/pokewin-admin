-- Manager-requested Discord channel creation for Fraud notification routing.
-- The dashboard queues requests in ADMIN; the Discord bot leases and executes
-- them only inside the configured Admin guild.

CREATE TABLE IF NOT EXISTS "discord_notification_channel_settings" (
  "guild_id" TEXT PRIMARY KEY
    REFERENCES "discord_notification_guilds"("guild_id") ON DELETE CASCADE,
  "default_parent_id" TEXT,
  "updated_by" UUID REFERENCES "admin_users"("id") ON DELETE SET NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "discord_notification_channel_settings_parent_fk"
    FOREIGN KEY ("guild_id", "default_parent_id")
    REFERENCES "discord_notification_channels"("guild_id", "channel_id")
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS "discord_notification_channel_jobs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "guild_id" TEXT NOT NULL,
  "parent_id" TEXT NOT NULL,
  "requested_name" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 5,
  "lease_token" UUID,
  "lease_owner" TEXT,
  "leased_until" TIMESTAMPTZ(6),
  "created_channel_id" TEXT,
  "created_channel_name" TEXT,
  "last_error_code" TEXT,
  "last_error_message" TEXT,
  "created_by" UUID REFERENCES "admin_users"("id") ON DELETE SET NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "completed_at" TIMESTAMPTZ(6),
  CONSTRAINT "discord_notification_channel_jobs_parent_fk"
    FOREIGN KEY ("guild_id", "parent_id")
    REFERENCES "discord_notification_channels"("guild_id", "channel_id")
    ON DELETE RESTRICT,
  CONSTRAINT "discord_notification_channel_jobs_status_check"
    CHECK ("status" IN ('pending', 'leased', 'created', 'dead')),
  CONSTRAINT "discord_notification_channel_jobs_attempt_check"
    CHECK ("attempt_count" >= 0 AND "max_attempts" BETWEEN 1 AND 25),
  CONSTRAINT "discord_notification_channel_jobs_name_check"
    CHECK (
      char_length("requested_name") BETWEEN 1 AND 100
      AND "requested_name" ~ '^[a-z0-9][a-z0-9-]*$'
    ),
  CONSTRAINT "discord_notification_channel_jobs_created_id_check"
    CHECK (
      "created_channel_id" IS NULL
      OR "created_channel_id" ~ '^[0-9]{15,21}$'
    )
);

CREATE INDEX IF NOT EXISTS "discord_notification_channel_jobs_claim_idx"
  ON "discord_notification_channel_jobs" ("guild_id", "available_at", "created_at")
  WHERE "status" IN ('pending', 'leased');

CREATE INDEX IF NOT EXISTS "discord_notification_channel_jobs_history_idx"
  ON "discord_notification_channel_jobs" ("guild_id", "created_at" DESC);
