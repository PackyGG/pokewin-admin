-- Per-user emergency override. Kept separate from the saved flow so enabling
-- it never resets or advances that user's current sequence position.
ALTER TABLE battle_test_user_sequences
  ADD COLUMN IF NOT EXISTS force_losses boolean NOT NULL DEFAULT false;
