CREATE TABLE IF NOT EXISTS battle_test_config (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    user_only_loses boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by text
);

INSERT INTO battle_test_config (singleton, user_only_loses)
VALUES (true, false)
ON CONFLICT (singleton) DO NOTHING;
