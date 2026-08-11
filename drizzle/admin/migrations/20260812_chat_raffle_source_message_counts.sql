-- Preserve per-source qualifying-message counts in each frozen draw snapshot.
-- NULL distinguishes legacy snapshots created before Community XP integration.
ALTER TABLE chat_raffle_entries
  ADD COLUMN IF NOT EXISTS discord_message_count integer,
  ADD COLUMN IF NOT EXISTS site_chat_message_count integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chat_raffle_entries_source_message_counts_check'
  ) THEN
    ALTER TABLE chat_raffle_entries
      ADD CONSTRAINT chat_raffle_entries_source_message_counts_check CHECK (
        (discord_message_count IS NULL AND site_chat_message_count IS NULL)
        OR (
          discord_message_count IS NOT NULL AND discord_message_count >= 0
          AND site_chat_message_count IS NOT NULL AND site_chat_message_count >= 0
          AND message_count = discord_message_count + site_chat_message_count
        )
      );
  END IF;
END $$;
