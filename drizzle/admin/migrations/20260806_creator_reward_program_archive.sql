-- Creator Rewards: program lifecycle (archive) + delete safety.
--
-- WHY THIS EXISTS
-- A reward program could be created and paused, but never removed. Operators
-- accumulated dead programs that still showed in the Hub list forever.
--
-- Removal has two shapes, and the FK graph is what forces the split:
--   creator_reward_program_windows  ON DELETE CASCADE
--   creator_reward_offer_windows    ON DELETE CASCADE
--   creator_reward_claims           ON DELETE RESTRICT   <-- the constraint
--
-- So a program that has ever produced a claim CANNOT be hard-deleted without
-- destroying payout history, which is exactly what the RESTRICT is there to
-- protect. Those get ARCHIVED instead: `archived_at` stamped, `is_active`
-- forced false, open accrual window closed. Every bot-facing read already
-- filters on `is_active = true`, so archiving takes the program out of Discord
-- offers with no further change. A program with zero claims is genuinely
-- disposable and is hard-deleted.
--
-- Idempotent; safe to re-run. The runner supplies the wrapping transaction.


ALTER TABLE creator_reward_programs
  ADD COLUMN IF NOT EXISTS archived_at timestamptz(6);

ALTER TABLE creator_reward_programs
  ADD COLUMN IF NOT EXISTS archived_by uuid;

COMMENT ON COLUMN creator_reward_programs.archived_at IS
  'Set when an operator retires a program that has claims and therefore cannot be deleted. Archived programs are hidden from the default Hub list and are never active.';

-- The Hub list reads live programs on every render; the partial index keeps
-- that read off the archived tail as the table grows.
CREATE INDEX IF NOT EXISTS creator_reward_programs_live_idx
  ON creator_reward_programs (created_at DESC)
  WHERE archived_at IS NULL;

-- An archived program must never be active. Enforced in the DB rather than
-- only in the action, because the toggle action writes is_active directly.
ALTER TABLE creator_reward_programs
  DROP CONSTRAINT IF EXISTS creator_reward_programs_archived_not_active;

ALTER TABLE creator_reward_programs
  ADD CONSTRAINT creator_reward_programs_archived_not_active
  CHECK (archived_at IS NULL OR is_active = false);

