CREATE TABLE IF NOT EXISTS "discord_vip_channel_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "guild_id" text NOT NULL,
  "user_id" text NOT NULL,
  "channel_id" text NOT NULL,
  "linked_by_discord_user_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "discord_vip_channel_links_guild_id_check"
    CHECK ("guild_id" ~ '^[0-9]{17,20}$'),
  CONSTRAINT "discord_vip_channel_links_user_id_check"
    CHECK (
      length("user_id") BETWEEN 8 AND 64
      AND "user_id" ~ '^[A-Za-z0-9_-]+$'
    ),
  CONSTRAINT "discord_vip_channel_links_channel_id_check"
    CHECK ("channel_id" ~ '^[0-9]{17,20}$'),
  CONSTRAINT "discord_vip_channel_links_actor_id_check"
    CHECK ("linked_by_discord_user_id" ~ '^[0-9]{17,20}$'),
  CONSTRAINT "discord_vip_channel_links_guild_user_unique"
    UNIQUE ("guild_id", "user_id"),
  CONSTRAINT "discord_vip_channel_links_guild_channel_unique"
    UNIQUE ("guild_id", "channel_id")
);

CREATE INDEX IF NOT EXISTS "discord_vip_channel_links_updated_idx"
  ON "discord_vip_channel_links" ("guild_id", "updated_at" DESC);

CREATE TABLE IF NOT EXISTS "discord_vip_channel_link_operations" (
  "interaction_id" text PRIMARY KEY NOT NULL,
  "guild_id" text NOT NULL,
  "user_id" text NOT NULL,
  "channel_id" text NOT NULL,
  "actor_discord_user_id" text NOT NULL,
  "status" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "discord_vip_channel_link_operations_interaction_id_check"
    CHECK ("interaction_id" ~ '^[0-9]{17,20}$'),
  CONSTRAINT "discord_vip_channel_link_operations_guild_id_check"
    CHECK ("guild_id" ~ '^[0-9]{17,20}$'),
  CONSTRAINT "discord_vip_channel_link_operations_user_id_check"
    CHECK (
      length("user_id") BETWEEN 8 AND 64
      AND "user_id" ~ '^[A-Za-z0-9_-]+$'
    ),
  CONSTRAINT "discord_vip_channel_link_operations_channel_id_check"
    CHECK ("channel_id" ~ '^[0-9]{17,20}$'),
  CONSTRAINT "discord_vip_channel_link_operations_actor_id_check"
    CHECK ("actor_discord_user_id" ~ '^[0-9]{17,20}$'),
  CONSTRAINT "discord_vip_channel_link_operations_status_check"
    CHECK ("status" IN ('linked', 'updated', 'already_linked'))
);

CREATE INDEX IF NOT EXISTS "discord_vip_channel_link_operations_created_idx"
  ON "discord_vip_channel_link_operations" ("created_at" DESC);

-- Grant only the deployed PackyGG Rewards Bot key the new least-privilege
-- capability. The prefix is a public key identifier, not credential material.
UPDATE "api_keys"
SET "scopes" = array_append("scopes", 'discord:vips:link')
WHERE "prefix" = 'pwa__WZ4VvUngxA4'
  AND "is_active" = true
  AND NOT ('discord:vips:link' = ANY("scopes"));
