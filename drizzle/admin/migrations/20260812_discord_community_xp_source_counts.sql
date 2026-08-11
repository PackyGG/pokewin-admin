-- Denormalize qualifying-message counts by source for lifetime leaderboard
-- reads. The immutable XP event ledger remains the backfill authority.
ALTER TABLE discord_community_xp_profiles
  ADD COLUMN IF NOT EXISTS discord_counted_messages integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS site_chat_counted_messages integer NOT NULL DEFAULT 0;

WITH counts AS (
  SELECT discord_user_id,
    count(*) FILTER (WHERE source = 'discord' AND awarded_xp > 0)::integer
      AS discord_counted_messages,
    count(*) FILTER (WHERE source = 'site_chat' AND awarded_xp > 0)::integer
      AS site_chat_counted_messages
  FROM discord_community_xp_events
  GROUP BY discord_user_id
)
UPDATE discord_community_xp_profiles profile
SET discord_counted_messages = counts.discord_counted_messages,
    site_chat_counted_messages = counts.site_chat_counted_messages
FROM counts
WHERE counts.discord_user_id = profile.discord_user_id;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'discord_community_xp_profiles_source_counts_check'
  ) THEN
    ALTER TABLE discord_community_xp_profiles
      ADD CONSTRAINT discord_community_xp_profiles_source_counts_check CHECK (
        discord_counted_messages >= 0
        AND site_chat_counted_messages >= 0
        AND counted_messages = discord_counted_messages + site_chat_counted_messages
      );
  END IF;
END $$;
