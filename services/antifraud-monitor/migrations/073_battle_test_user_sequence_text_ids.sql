ALTER TABLE battle_test_user_sequences
    ALTER COLUMN user_id TYPE text USING user_id::text;

ALTER TABLE battle_test_user_sequences
    ADD CONSTRAINT battle_test_user_sequences_user_id_length
    CHECK (char_length(user_id) BETWEEN 1 AND 100);
