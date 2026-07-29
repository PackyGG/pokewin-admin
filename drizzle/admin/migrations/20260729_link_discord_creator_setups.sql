-- Bind an active Discord creator section to its canonical Packy creator account.
-- The account is verified against the read-only MAIN mirror by the API; only
-- the resulting reference and command audit data are stored in the ADMIN DB.

ALTER TABLE "discord_creator_setups"
  ADD COLUMN IF NOT EXISTS "creator_user_id" TEXT,
  ADD COLUMN IF NOT EXISTS "linked_by_discord_user_id" TEXT,
  ADD COLUMN IF NOT EXISTS "link_interaction_id" TEXT,
  ADD COLUMN IF NOT EXISTS "linked_at" TIMESTAMPTZ(6);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'discord_creator_setups_link_actor_id_check'
      AND conrelid = 'discord_creator_setups'::regclass
  ) THEN
    ALTER TABLE "discord_creator_setups"
      ADD CONSTRAINT "discord_creator_setups_link_actor_id_check"
      CHECK (
        "linked_by_discord_user_id" IS NULL
        OR "linked_by_discord_user_id" ~ '^[0-9]{15,21}$'
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'discord_creator_setups_creator_user_id_check'
      AND conrelid = 'discord_creator_setups'::regclass
  ) THEN
    ALTER TABLE "discord_creator_setups"
      ADD CONSTRAINT "discord_creator_setups_creator_user_id_check"
      CHECK (
        "creator_user_id" IS NULL
        OR (
          length("creator_user_id") BETWEEN 8 AND 64
          AND "creator_user_id" ~ '^[A-Za-z0-9_-]+$'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'discord_creator_setups_link_interaction_id_check'
      AND conrelid = 'discord_creator_setups'::regclass
  ) THEN
    ALTER TABLE "discord_creator_setups"
      ADD CONSTRAINT "discord_creator_setups_link_interaction_id_check"
      CHECK (
        "link_interaction_id" IS NULL
        OR "link_interaction_id" ~ '^[0-9]{15,21}$'
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'discord_creator_setups_link_shape_check'
      AND conrelid = 'discord_creator_setups'::regclass
  ) THEN
    ALTER TABLE "discord_creator_setups"
      ADD CONSTRAINT "discord_creator_setups_link_shape_check"
      CHECK (
        (
          "creator_user_id" IS NULL
          AND "linked_by_discord_user_id" IS NULL
          AND "link_interaction_id" IS NULL
          AND "linked_at" IS NULL
        )
        OR (
          "status" = 'active'
          AND "creator_user_id" IS NOT NULL
          AND "linked_by_discord_user_id" IS NOT NULL
          AND "link_interaction_id" IS NOT NULL
          AND "linked_at" IS NOT NULL
        )
      );
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS "discord_creator_setups_link_interaction_unique"
  ON "discord_creator_setups" ("link_interaction_id")
  WHERE "link_interaction_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "discord_creator_setups_guild_creator_user_unique"
  ON "discord_creator_setups" ("guild_id", "creator_user_id")
  WHERE "creator_user_id" IS NOT NULL;
