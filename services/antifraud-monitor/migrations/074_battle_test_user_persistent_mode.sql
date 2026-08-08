ALTER TABLE battle_test_user_sequences
    ADD COLUMN IF NOT EXISTS persistent boolean NOT NULL DEFAULT false;
