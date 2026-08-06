-- Optional scheduled end for Creator Rewards programs.
-- The start remains the immutable creation timestamp.

ALTER TABLE creator_reward_programs
  ADD COLUMN IF NOT EXISTS ends_at timestamptz(6);

ALTER TABLE creator_reward_programs
  DROP CONSTRAINT IF EXISTS creator_reward_programs_end_after_start;

ALTER TABLE creator_reward_programs
  ADD CONSTRAINT creator_reward_programs_end_after_start
  CHECK (ends_at IS NULL OR ends_at > accrual_start_at);

COMMENT ON COLUMN creator_reward_programs.ends_at IS
  'Optional scheduled stop. Accrual and new claims stop at this timestamp; null means open-ended.';
