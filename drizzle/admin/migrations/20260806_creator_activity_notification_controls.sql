-- Split creator sign-up and deposit notifications into independent controls.
-- Existing sections keep their current combined preference for both streams.

ALTER TABLE "discord_creator_setups"
  ADD COLUMN IF NOT EXISTS "signup_notifications_enabled" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "signup_notifications_enabled_at" TIMESTAMPTZ(6);

UPDATE "discord_creator_setups"
SET
  "signup_notifications_enabled" = "deposit_notifications_enabled",
  "signup_notifications_enabled_at" = "deposit_notifications_enabled_at"
WHERE "signup_notifications_enabled" IS NULL;

ALTER TABLE "discord_creator_setups"
  ALTER COLUMN "signup_notifications_enabled" SET DEFAULT true,
  ALTER COLUMN "signup_notifications_enabled" SET NOT NULL,
  ALTER COLUMN "signup_notifications_enabled_at" SET DEFAULT now();

CREATE INDEX IF NOT EXISTS "discord_creator_setups_signup_notifications_idx"
  ON "discord_creator_setups" ("guild_id", "creator_user_id")
  WHERE
    "status" = 'active'
    AND "creator_user_id" IS NOT NULL
    AND "signup_notifications_enabled" = true;
