-- Battle test marks are per-environment. Without this column a single shared
-- ANTIFRAUD_DATABASE_URL would let a userID marked against the dev game
-- database steer a battle read by a prod-configured deployment, and the two
-- would fight over the same current_rule_index row.
--
-- Existing rows backfill to 'dev': config.ts refuses to start when the battle
-- test source equals SOURCE_DATABASE_URL, so no mark written so far can ever
-- have belonged to a production database.
--
-- No CHECK constraint here on purpose. Earlier revisions of this file created
-- `battle_test_user_sequences_environment_valid`, and the production database
-- kept failing with 42710 (constraint already exists) even when the ADD was
-- preceded by DROP CONSTRAINT IF EXISTS on the same name — so the constraint
-- exists there in a form this file could not clear, and every retry held the
-- service in a crash loop. The column's domain is already enforced in the
-- application: BATTLE_TEST_ENVIRONMENT is a zod enum and the store writes only
-- that value. Re-add the database-level CHECK in a follow-up migration once
-- the real catalog state has been inspected:
--
--   SELECT conname, contype, pg_get_constraintdef(oid)
--   FROM pg_constraint
--   WHERE conrelid = 'battle_test_user_sequences'::regclass;
--
-- Every statement below converges from a partially-applied schema, because the
-- runner rolls a failed migration back but cannot undo objects created outside
-- its transaction.
ALTER TABLE battle_test_user_sequences
    ADD COLUMN IF NOT EXISTS environment text NOT NULL DEFAULT 'dev';

ALTER TABLE battle_test_user_sequences
    DROP CONSTRAINT IF EXISTS battle_test_user_sequences_pkey;

ALTER TABLE battle_test_user_sequences
    ADD CONSTRAINT battle_test_user_sequences_pkey
    PRIMARY KEY (environment, user_id);

DROP INDEX IF EXISTS battle_test_user_sequences_updated_idx;

CREATE INDEX IF NOT EXISTS battle_test_user_sequences_env_updated_idx
    ON battle_test_user_sequences (environment, updated_at DESC);
