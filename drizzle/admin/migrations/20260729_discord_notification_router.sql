-- Durable Discord bot routing for Antifraud notifications.
-- Configuration and delivery state belong to the ADMIN database. The MAIN
-- game/customer database is not involved.

CREATE TABLE IF NOT EXISTS "discord_notification_guilds" (
  "guild_id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "connected" BOOLEAN NOT NULL DEFAULT true,
  "last_synced_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "discord_notification_guilds_id_check"
    CHECK ("guild_id" ~ '^[0-9]{15,21}$')
);

CREATE TABLE IF NOT EXISTS "discord_notification_channels" (
  "guild_id" TEXT NOT NULL REFERENCES "discord_notification_guilds"("guild_id") ON DELETE CASCADE,
  "channel_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "parent_id" TEXT,
  "parent_name" TEXT,
  "position" INTEGER NOT NULL DEFAULT 0,
  "can_view" BOOLEAN NOT NULL DEFAULT false,
  "can_send" BOOLEAN NOT NULL DEFAULT false,
  "can_embed" BOOLEAN NOT NULL DEFAULT false,
  "available" BOOLEAN NOT NULL DEFAULT true,
  "last_synced_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  PRIMARY KEY ("guild_id", "channel_id"),
  CONSTRAINT "discord_notification_channels_id_check"
    CHECK ("channel_id" ~ '^[0-9]{15,21}$')
);

CREATE INDEX IF NOT EXISTS "discord_notification_channels_guild_position_idx"
  ON "discord_notification_channels" ("guild_id", "available", "position", "name");

CREATE TABLE IF NOT EXISTS "discord_notification_events" (
  "event_key" TEXT PRIMARY KEY,
  "label" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "category" TEXT NOT NULL,
  "is_custom" BOOLEAN NOT NULL DEFAULT false,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_by" UUID REFERENCES "admin_users"("id") ON DELETE SET NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "discord_notification_events_key_check"
    CHECK ("event_key" ~ '^[a-z0-9][a-z0-9._-]{2,79}$')
);

INSERT INTO "discord_notification_events"
  ("event_key", "label", "description", "category", "is_custom")
VALUES
  ('antifraud.signup_high_risk', 'High-risk signup', 'A signup crossed the automated review threshold.', 'Signups', false),
  ('antifraud.rule_matched', 'Antifraud rule matched', 'A monitored account matched an enabled antifraud rule.', 'Rules', false),
  ('antifraud.fiat_risk', 'High-risk fiat payment', 'A fiat assessment or locked-account payment needs risk review.', 'Fiat', false),
  ('antifraud.fiat_operations', 'Fiat operations issue', 'A failed, delayed, disputed, refunded, or unreconciled fiat operation needs attention.', 'Fiat', false),
  ('antifraud.email_blacklist', 'Blocked email detected', 'A signup or checkout matched the email containment policy.', 'Containment', false),
  ('antifraud.withdrawal_hold', 'Automatic withdrawal hold', 'The automatic lifetime-fiat withdrawal hold was applied.', 'Containment', false)
ON CONFLICT ("event_key") DO UPDATE SET
  "label" = EXCLUDED."label",
  "description" = EXCLUDED."description",
  "category" = EXCLUDED."category",
  "is_custom" = false,
  "updated_at" = now();

CREATE TABLE IF NOT EXISTS "discord_notification_routes" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "guild_id" TEXT NOT NULL,
  "event_key" TEXT NOT NULL REFERENCES "discord_notification_events"("event_key") ON DELETE CASCADE,
  "channel_id" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_by" UUID REFERENCES "admin_users"("id") ON DELETE SET NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "discord_notification_routes_channel_fk"
    FOREIGN KEY ("guild_id", "channel_id")
    REFERENCES "discord_notification_channels"("guild_id", "channel_id")
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS "discord_notification_routes_unique"
  ON "discord_notification_routes" ("guild_id", "event_key", "channel_id");
CREATE INDEX IF NOT EXISTS "discord_notification_routes_dispatch_idx"
  ON "discord_notification_routes" ("guild_id", "event_key")
  WHERE "enabled";

CREATE TABLE IF NOT EXISTS "discord_notification_jobs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "guild_id" TEXT NOT NULL,
  "event_key" TEXT NOT NULL REFERENCES "discord_notification_events"("event_key") ON DELETE RESTRICT,
  "channel_id" TEXT NOT NULL,
  "dedupe_key" TEXT NOT NULL,
  "content" TEXT,
  "embed" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 10,
  "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "lease_token" UUID,
  "lease_owner" TEXT,
  "leased_until" TIMESTAMPTZ(6),
  "discord_message_id" TEXT,
  "last_error_code" TEXT,
  "last_error_message" TEXT,
  "delivered_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "discord_notification_jobs_status_check"
    CHECK ("status" IN ('pending', 'leased', 'delivered', 'dead')),
  CONSTRAINT "discord_notification_jobs_attempt_check"
    CHECK ("attempt_count" >= 0 AND "max_attempts" BETWEEN 1 AND 25),
  CONSTRAINT "discord_notification_jobs_channel_fk"
    FOREIGN KEY ("guild_id", "channel_id")
    REFERENCES "discord_notification_channels"("guild_id", "channel_id")
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS "discord_notification_jobs_dedupe_idx"
  ON "discord_notification_jobs" ("guild_id", "event_key", "dedupe_key", "channel_id");
CREATE INDEX IF NOT EXISTS "discord_notification_jobs_claim_idx"
  ON "discord_notification_jobs" ("guild_id", "available_at", "created_at")
  WHERE "status" IN ('pending', 'leased');
CREATE INDEX IF NOT EXISTS "discord_notification_jobs_history_idx"
  ON "discord_notification_jobs" ("guild_id", "created_at" DESC);
