ALTER TABLE "discord_giveaways"
  DROP CONSTRAINT IF EXISTS "discord_giveaways_entry_requirement_check";

ALTER TABLE "discord_giveaways"
  ADD CONSTRAINT "discord_giveaways_entry_requirement_check"
  CHECK (
    "entry_requirement" IN (
      'none',
      'linked_packy_account',
      'established_linked_packy_account'
    )
  );
