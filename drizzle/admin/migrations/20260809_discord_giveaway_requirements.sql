ALTER TABLE "discord_giveaways"
  ADD COLUMN IF NOT EXISTS "entry_requirement" text NOT NULL DEFAULT 'none';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'discord_giveaways_entry_requirement_check'
  ) THEN
    ALTER TABLE "discord_giveaways"
      ADD CONSTRAINT "discord_giveaways_entry_requirement_check"
      CHECK ("entry_requirement" IN ('none', 'linked_packy_account'));
  END IF;
END
$$;
