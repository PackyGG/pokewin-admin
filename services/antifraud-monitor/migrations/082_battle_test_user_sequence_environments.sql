-- Battle test marks are per-environment. Without this column a single shared
-- ANTIFRAUD_DATABASE_URL would let a userID marked against the dev game
-- database steer a battle read by a prod-configured deployment, and the two
-- would fight over the same current_rule_index row.
--
-- Existing rows backfill to 'dev': config.ts refuses to start when the battle
-- test source equals SOURCE_DATABASE_URL, so no mark written so far can ever
-- have belonged to a production database.
--
-- Every statement converges from a partially-applied schema. The runner wraps
-- each migration in a transaction, so a failure here rolls back and the file is
-- retried on the next boot — but an object created OUTSIDE that transaction (a
-- hand-applied ALTER) survives, and a bare ADD CONSTRAINT would then fail with
-- 42710 on every retry and hold the service in a crash loop. Hence
-- drop-then-add for both named constraints: the DROP matches by name whatever
-- is there, the ADD leaves exactly the definition this file specifies.
ALTER TABLE battle_test_user_sequences
    ADD COLUMN IF NOT EXISTS environment text NOT NULL DEFAULT 'dev';

ALTER TABLE battle_test_user_sequences
    DROP CONSTRAINT IF EXISTS battle_test_user_sequences_environment_valid;

ALTER TABLE battle_test_user_sequences
    ADD CONSTRAINT battle_test_user_sequences_environment_valid
    CHECK (environment IN ('dev', 'prod'));

ALTER TABLE battle_test_user_sequences
    DROP CONSTRAINT IF EXISTS battle_test_user_sequences_pkey;

ALTER TABLE battle_test_user_sequences
    ADD CONSTRAINT battle_test_user_sequences_pkey
    PRIMARY KEY (environment, user_id);

DROP INDEX IF EXISTS battle_test_user_sequences_updated_idx;

CREATE INDEX IF NOT EXISTS battle_test_user_sequences_env_updated_idx
    ON battle_test_user_sequences (environment, updated_at DESC);
