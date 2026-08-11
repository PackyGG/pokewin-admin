-- Freeze the combined Community XP provenance used by Chat Raffle draws.
-- Existing snapshots stay distinguishable as legacy rows through NULLs;
-- every draw created after this migration writes all five columns.
ALTER TABLE chat_raffle_entries
  ADD COLUMN IF NOT EXISTS discord_user_id text,
  ADD COLUMN IF NOT EXISTS discord_xp integer,
  ADD COLUMN IF NOT EXISTS site_chat_xp integer,
  ADD COLUMN IF NOT EXISTS community_total_xp integer,
  ADD COLUMN IF NOT EXISTS community_level integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chat_raffle_entries_community_xp_check'
  ) THEN
    ALTER TABLE chat_raffle_entries
      ADD CONSTRAINT chat_raffle_entries_community_xp_check CHECK (
        (discord_user_id IS NULL OR discord_user_id ~ '^[0-9]{17,20}$')
        AND (discord_xp IS NULL OR discord_xp >= 0)
        AND (site_chat_xp IS NULL OR site_chat_xp >= 0)
        AND (community_total_xp IS NULL OR community_total_xp >= 0)
        AND (community_level IS NULL OR community_level >= 0)
        AND (
          (discord_xp IS NULL AND site_chat_xp IS NULL)
          OR (discord_xp IS NOT NULL AND site_chat_xp IS NOT NULL
            AND base_points = discord_xp + site_chat_xp)
        )
      );
  END IF;
END $$;
