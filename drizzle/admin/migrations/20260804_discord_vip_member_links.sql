ALTER TABLE "discord_vip_channel_links"
  ADD COLUMN IF NOT EXISTS "member_discord_user_id" text;

ALTER TABLE "discord_vip_channel_link_operations"
  ADD COLUMN IF NOT EXISTS "member_discord_user_id" text,
  ADD COLUMN IF NOT EXISTS "vip_tag_added" boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'discord_vip_channel_links_member_id_check'
  ) THEN
    ALTER TABLE "discord_vip_channel_links"
      ADD CONSTRAINT "discord_vip_channel_links_member_id_check"
      CHECK (
        "member_discord_user_id" IS NULL
        OR "member_discord_user_id" ~ '^[0-9]{17,20}$'
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'discord_vip_channel_link_operations_member_id_check'
  ) THEN
    ALTER TABLE "discord_vip_channel_link_operations"
      ADD CONSTRAINT "discord_vip_channel_link_operations_member_id_check"
      CHECK (
        "member_discord_user_id" IS NULL
        OR "member_discord_user_id" ~ '^[0-9]{17,20}$'
      );
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS
  "discord_vip_channel_links_guild_member_unique"
  ON "discord_vip_channel_links" ("guild_id", "member_discord_user_id")
  WHERE "member_discord_user_id" IS NOT NULL;
