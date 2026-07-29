-- Durable, idempotent creator-channel provisioning state for the Discord bot.
-- This belongs to the ADMIN database; the MAIN game database remains read-only.

CREATE TABLE IF NOT EXISTS "discord_creator_setups" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "guild_id" TEXT NOT NULL,
  "creator_discord_user_id" TEXT NOT NULL,
  "created_by_discord_user_id" TEXT NOT NULL,
  "interaction_id" TEXT NOT NULL UNIQUE,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "category_id" TEXT,
  "chat_channel_id" TEXT,
  "logs_channel_id" TEXT,
  "category_name" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "completed_at" TIMESTAMPTZ(6),
  CONSTRAINT "discord_creator_setups_creator_unique"
    UNIQUE ("guild_id", "creator_discord_user_id"),
  CONSTRAINT "discord_creator_setups_guild_id_check"
    CHECK ("guild_id" ~ '^[0-9]{15,21}$'),
  CONSTRAINT "discord_creator_setups_creator_id_check"
    CHECK ("creator_discord_user_id" ~ '^[0-9]{15,21}$'),
  CONSTRAINT "discord_creator_setups_actor_id_check"
    CHECK ("created_by_discord_user_id" ~ '^[0-9]{15,21}$'),
  CONSTRAINT "discord_creator_setups_interaction_id_check"
    CHECK ("interaction_id" ~ '^[0-9]{15,21}$'),
  CONSTRAINT "discord_creator_setups_status_check"
    CHECK ("status" IN ('pending', 'active')),
  CONSTRAINT "discord_creator_setups_active_shape_check"
    CHECK (
      "status" = 'pending'
      OR (
        "category_id" ~ '^[0-9]{15,21}$'
        AND "chat_channel_id" ~ '^[0-9]{15,21}$'
        AND "logs_channel_id" ~ '^[0-9]{15,21}$'
        AND length("category_name") BETWEEN 1 AND 100
        AND "completed_at" IS NOT NULL
      )
    )
);

CREATE INDEX IF NOT EXISTS "discord_creator_setups_pending_created_idx"
  ON "discord_creator_setups" ("created_at")
  WHERE "status" = 'pending';
