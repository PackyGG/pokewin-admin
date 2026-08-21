-- Scope the legacy global EOS steering switch to a deployment environment.
-- Existing state belongs to dev, matching the service's historical default.
ALTER TABLE battle_test_config
  ADD COLUMN IF NOT EXISTS environment text NOT NULL DEFAULT 'dev';
-- Keep the legacy `WHERE singleton = true` query pinned to the dev row while
-- old instances drain during a rolling deployment.
ALTER TABLE battle_test_config
  DROP CONSTRAINT IF EXISTS battle_test_config_singleton_check;
ALTER TABLE battle_test_config
  ADD CONSTRAINT battle_test_config_legacy_singleton_scope
  CHECK (singleton = (environment = 'dev'));
ALTER TABLE battle_test_config
  DROP CONSTRAINT IF EXISTS battle_test_config_singleton_key;
ALTER TABLE battle_test_config
  ADD CONSTRAINT battle_test_config_singleton_key UNIQUE (singleton);
ALTER TABLE battle_test_config
  DROP CONSTRAINT IF EXISTS battle_test_config_environment_valid;
ALTER TABLE battle_test_config
  ADD CONSTRAINT battle_test_config_environment_valid
  CHECK (environment IN ('dev', 'prod'));
ALTER TABLE battle_test_config DROP CONSTRAINT IF EXISTS battle_test_config_pkey;
ALTER TABLE battle_test_config
  ADD CONSTRAINT battle_test_config_pkey PRIMARY KEY (environment);

-- Global steering uses the same flow model as user overrides. `persistent`
-- repeats a flow, while `randomized` treats rule counts as relative weights.
ALTER TABLE battle_test_config
  ADD COLUMN IF NOT EXISTS rules jsonb NOT NULL DEFAULT
    '[{"target":"any","strategy":"random","count":1}]'::jsonb,
  ADD COLUMN IF NOT EXISTS current_rule_index integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS remaining_in_rule integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS persistent boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS randomized boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT false;
UPDATE battle_test_config
SET rules = '[{"target":"loss","strategy":"random","count":1}]'::jsonb,
    enabled = true
WHERE user_only_loses = true
  AND rules = '[{"target":"any","strategy":"random","count":1}]'::jsonb;
ALTER TABLE battle_test_config DROP CONSTRAINT IF EXISTS battle_test_config_rules_array;
ALTER TABLE battle_test_config ADD CONSTRAINT battle_test_config_rules_array
  CHECK (jsonb_typeof(rules) = 'array' AND jsonb_array_length(rules) BETWEEN 1 AND 20);
ALTER TABLE battle_test_config DROP CONSTRAINT IF EXISTS battle_test_config_rule_index_nonnegative;
ALTER TABLE battle_test_config ADD CONSTRAINT battle_test_config_rule_index_nonnegative
  CHECK (current_rule_index >= 0);
ALTER TABLE battle_test_config DROP CONSTRAINT IF EXISTS battle_test_config_remaining_nonnegative;
ALTER TABLE battle_test_config ADD CONSTRAINT battle_test_config_remaining_nonnegative
  CHECK (remaining_in_rule >= 0);

ALTER TABLE battle_test_user_sequences
  ADD COLUMN IF NOT EXISTS randomized boolean NOT NULL DEFAULT false;

-- A durable response per battle makes retries return the same block and keeps
-- a personal sequence from advancing twice. Intentionally no FK to the user
-- rule: deleting a future rule must retain already-routed battle responses.
CREATE TABLE IF NOT EXISTS battle_test_eos_selections (
  environment text NOT NULL,
  battle_id uuid NOT NULL,
  user_id text NOT NULL,
  instruction jsonb,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  selected_at timestamptz,
  PRIMARY KEY (environment, battle_id),
  CHECK (environment IN ('dev', 'prod')),
  CHECK (char_length(user_id) BETWEEN 1 AND 100),
  CHECK (instruction IS NULL OR jsonb_typeof(instruction) = 'object'),
  CHECK (response IS NULL OR jsonb_typeof(response) = 'object'),
  CHECK ((response IS NULL) = (selected_at IS NULL))
);
CREATE INDEX IF NOT EXISTS battle_test_eos_selections_user_created_idx
  ON battle_test_eos_selections (environment, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS battle_test_eos_selections_created_idx
  ON battle_test_eos_selections (created_at);
