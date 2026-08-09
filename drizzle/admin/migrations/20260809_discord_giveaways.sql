CREATE TABLE IF NOT EXISTS "discord_giveaways" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "interaction_id" text NOT NULL UNIQUE,
  "guild_id" text NOT NULL,
  "channel_id" text NOT NULL,
  "creator_discord_user_id" text NOT NULL,
  "prize" text NOT NULL,
  "winner_count" smallint NOT NULL,
  "ends_at" timestamptz NOT NULL,
  "status" text NOT NULL DEFAULT 'pending_message',
  "discord_message_id" text UNIQUE,
  "revision" integer NOT NULL DEFAULT 1,
  "delivered_revision" integer NOT NULL DEFAULT 0,
  "delivery_status" text NOT NULL DEFAULT 'pending',
  "attempt_count" integer NOT NULL DEFAULT 0,
  "max_attempts" integer NOT NULL DEFAULT 20,
  "available_at" timestamptz NOT NULL DEFAULT now(),
  "lease_token" uuid,
  "lease_owner" text,
  "leased_until" timestamptz,
  "last_error_code" text,
  "last_error_message" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "ended_at" timestamptz,
  CONSTRAINT "discord_giveaways_snowflakes_check" CHECK (
    "interaction_id" ~ '^[0-9]{17,20}$'
    AND "guild_id" ~ '^[0-9]{17,20}$'
    AND "channel_id" ~ '^[0-9]{17,20}$'
    AND "creator_discord_user_id" ~ '^[0-9]{17,20}$'
    AND ("discord_message_id" IS NULL OR "discord_message_id" ~ '^[0-9]{17,20}$')
  ),
  CONSTRAINT "discord_giveaways_prize_check" CHECK (
    char_length(btrim("prize")) BETWEEN 1 AND 1000
  ),
  CONSTRAINT "discord_giveaways_winner_count_check" CHECK ("winner_count" BETWEEN 1 AND 20),
  CONSTRAINT "discord_giveaways_status_check" CHECK (
    "status" IN ('pending_message', 'active', 'ended', 'cancelled')
  ),
  CONSTRAINT "discord_giveaways_delivery_status_check" CHECK (
    "delivery_status" IN ('pending', 'leased', 'delivered', 'dead')
  ),
  CONSTRAINT "discord_giveaways_revision_check" CHECK (
    "revision" >= 1 AND "delivered_revision" BETWEEN 0 AND "revision"
  ),
  CONSTRAINT "discord_giveaways_attempt_check" CHECK (
    "attempt_count" >= 0 AND "max_attempts" BETWEEN 1 AND 50
  ),
  CONSTRAINT "discord_giveaways_lease_shape_check" CHECK (
    ("delivery_status" = 'leased' AND "lease_token" IS NOT NULL AND "lease_owner" IS NOT NULL AND "leased_until" IS NOT NULL)
    OR
    ("delivery_status" <> 'leased' AND "lease_token" IS NULL AND "lease_owner" IS NULL AND "leased_until" IS NULL)
  ),
  CONSTRAINT "discord_giveaways_message_shape_check" CHECK (
    ("status" = 'pending_message' AND "discord_message_id" IS NULL)
    OR
    ("status" <> 'pending_message')
  )
);

CREATE TABLE IF NOT EXISTS "discord_giveaway_entries" (
  "giveaway_id" uuid NOT NULL REFERENCES "discord_giveaways"("id") ON DELETE CASCADE,
  "discord_user_id" text NOT NULL,
  "entered_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("giveaway_id", "discord_user_id"),
  CONSTRAINT "discord_giveaway_entries_user_check"
    CHECK ("discord_user_id" ~ '^[0-9]{17,20}$')
);

CREATE TABLE IF NOT EXISTS "discord_giveaway_winners" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "giveaway_id" uuid NOT NULL REFERENCES "discord_giveaways"("id") ON DELETE CASCADE,
  "revision" integer NOT NULL,
  "position" smallint NOT NULL,
  "discord_user_id" text NOT NULL,
  "active" boolean NOT NULL DEFAULT true,
  "selected_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "discord_giveaway_winners_revision_check" CHECK ("revision" >= 2),
  CONSTRAINT "discord_giveaway_winners_position_check" CHECK ("position" BETWEEN 1 AND 20),
  CONSTRAINT "discord_giveaway_winners_user_check"
    CHECK ("discord_user_id" ~ '^[0-9]{17,20}$')
);

CREATE TABLE IF NOT EXISTS "discord_giveaway_rerolls" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "interaction_id" text NOT NULL UNIQUE,
  "giveaway_id" uuid NOT NULL REFERENCES "discord_giveaways"("id") ON DELETE CASCADE,
  "actor_discord_user_id" text NOT NULL,
  "target_winner_discord_user_id" text,
  "revision" integer NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "discord_giveaway_rerolls_snowflakes_check" CHECK (
    "interaction_id" ~ '^[0-9]{17,20}$'
    AND "actor_discord_user_id" ~ '^[0-9]{17,20}$'
    AND (
      "target_winner_discord_user_id" IS NULL
      OR "target_winner_discord_user_id" ~ '^[0-9]{17,20}$'
    )
  ),
  CONSTRAINT "discord_giveaway_rerolls_revision_check" CHECK ("revision" >= 3)
);

CREATE UNIQUE INDEX IF NOT EXISTS "discord_giveaway_winners_active_position_idx"
  ON "discord_giveaway_winners" ("giveaway_id", "position")
  WHERE "active";

CREATE UNIQUE INDEX IF NOT EXISTS "discord_giveaway_winners_active_user_idx"
  ON "discord_giveaway_winners" ("giveaway_id", "discord_user_id")
  WHERE "active";

CREATE INDEX IF NOT EXISTS "discord_giveaways_due_idx"
  ON "discord_giveaways" ("ends_at", "id")
  WHERE "status" = 'active';

CREATE INDEX IF NOT EXISTS "discord_giveaways_delivery_idx"
  ON "discord_giveaways" ("available_at", "created_at", "id")
  WHERE "delivery_status" IN ('pending', 'leased');

CREATE INDEX IF NOT EXISTS "discord_giveaway_entries_draw_idx"
  ON "discord_giveaway_entries" ("giveaway_id", "entered_at", "discord_user_id");

UPDATE "api_keys"
SET "scopes" = array_append("scopes", 'discord:giveaways')
WHERE "prefix" = 'pwa__WZ4VvUngxA4'
  AND "is_active" = true
  AND NOT ('discord:giveaways' = ANY("scopes"));
