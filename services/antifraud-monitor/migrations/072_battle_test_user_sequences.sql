CREATE TABLE IF NOT EXISTS battle_test_user_sequences (
    user_id uuid PRIMARY KEY,
    username text,
    rules jsonb NOT NULL,
    current_rule_index integer NOT NULL DEFAULT 0,
    remaining_in_rule integer NOT NULL DEFAULT 0,
    enabled boolean NOT NULL DEFAULT true,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by text,
    CONSTRAINT battle_test_user_sequences_rules_array
        CHECK (jsonb_typeof(rules) = 'array'),
    CONSTRAINT battle_test_user_sequences_rule_index_nonnegative
        CHECK (current_rule_index >= 0),
    CONSTRAINT battle_test_user_sequences_remaining_nonnegative
        CHECK (remaining_in_rule >= 0)
);

CREATE INDEX IF NOT EXISTS battle_test_user_sequences_updated_idx
    ON battle_test_user_sequences (updated_at DESC);
