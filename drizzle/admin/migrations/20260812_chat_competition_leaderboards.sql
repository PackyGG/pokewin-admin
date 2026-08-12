ALTER TABLE chat_raffle_rounds
  ADD COLUMN IF NOT EXISTS competition_type text NOT NULL DEFAULT 'raffle';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chat_raffle_rounds_competition_type_check'
  ) THEN
    ALTER TABLE chat_raffle_rounds
      ADD CONSTRAINT chat_raffle_rounds_competition_type_check
      CHECK (competition_type IN ('raffle', 'leaderboard'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS chat_raffle_rounds_type_status_idx
  ON chat_raffle_rounds (competition_type, status, starts_at DESC);

ALTER TABLE chat_raffle_entries
  ADD COLUMN IF NOT EXISTS score_reached_at timestamptz;
