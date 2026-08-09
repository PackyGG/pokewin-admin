-- Preserve creator-section history while allowing an authorized Discord admin
-- to unlink an exact active setup after its channels have been removed.
-- ADMIN database only.

ALTER TABLE "discord_creator_setups"
  ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "deleted_by_discord_user_id" TEXT,
  ADD COLUMN IF NOT EXISTS "delete_interaction_id" TEXT;

ALTER TABLE "discord_creator_setups"
  DROP CONSTRAINT IF EXISTS "discord_creator_setups_creator_unique",
  DROP CONSTRAINT IF EXISTS "discord_creator_setups_status_check";

ALTER TABLE "discord_creator_setups"
  ADD CONSTRAINT "discord_creator_setups_status_check"
    CHECK ("status" IN ('pending', 'active', 'deleted')),
  ADD CONSTRAINT "discord_creator_setups_deletion_shape_check"
    CHECK (
      (
        "status" <> 'deleted'
        AND "deleted_at" IS NULL
        AND "deleted_by_discord_user_id" IS NULL
        AND "delete_interaction_id" IS NULL
      )
      OR (
        "status" = 'deleted'
        AND "deleted_at" IS NOT NULL
        AND "deleted_by_discord_user_id" ~ '^[0-9]{15,21}$'
        AND "delete_interaction_id" ~ '^[0-9]{15,21}$'
        AND "creator_user_id" IS NULL
        AND "linked_by_discord_user_id" IS NULL
        AND "link_interaction_id" IS NULL
        AND "linked_at" IS NULL
      )
    );

CREATE UNIQUE INDEX IF NOT EXISTS "discord_creator_setups_live_creator_unique"
  ON "discord_creator_setups" ("guild_id", "creator_discord_user_id")
  WHERE "status" IN ('pending', 'active');

CREATE UNIQUE INDEX IF NOT EXISTS "discord_creator_setups_delete_interaction_unique"
  ON "discord_creator_setups" ("delete_interaction_id")
  WHERE "delete_interaction_id" IS NOT NULL;
