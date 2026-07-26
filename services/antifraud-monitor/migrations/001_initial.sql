CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS source_cursors (
  stream text PRIMARY KEY,
  occurred_at timestamptz NOT NULL,
  source_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subjects (
  user_id text PRIMARY KEY,
  username text,
  email text,
  avatar_url text,
  signup_ip inet,
  country text,
  country_code text,
  continent_code text,
  state text,
  city text,
  affiliate_code text,
  referred_by text,
  source_created_at timestamptz NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS subjects_signup_time_idx
  ON subjects(source_created_at DESC, user_id DESC);

CREATE TABLE IF NOT EXISTS provider_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES subjects(user_id) ON DELETE CASCADE,
  provider text NOT NULL,
  lookup_key text NOT NULL,
  request_id text,
  status text NOT NULL,
  score numeric(8,2),
  signals jsonb NOT NULL DEFAULT '[]'::jsonb,
  response jsonb,
  error_code text,
  checked_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  UNIQUE (user_id, provider, lookup_key)
);

CREATE INDEX IF NOT EXISTS provider_checks_cache_idx
  ON provider_checks(provider, lookup_key, expires_at DESC)
  WHERE status = 'success';

CREATE TABLE IF NOT EXISTS signup_assessments (
  user_id text PRIMARY KEY REFERENCES subjects(user_id) ON DELETE CASCADE,
  score integer NOT NULL DEFAULT 0,
  severity text NOT NULL DEFAULT 'low'
    CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  signals jsonb NOT NULL DEFAULT '[]'::jsonb,
  assessed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS signup_assessments_risk_idx
  ON signup_assessments(score DESC, assessed_at DESC);

CREATE TABLE IF NOT EXISTS cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES subjects(user_id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'open',
  severity text NOT NULL DEFAULT 'low',
  score integer NOT NULL DEFAULT 0,
  peak_score integer NOT NULL DEFAULT 0,
  summary text NOT NULL,
  assigned_to text,
  resolution text,
  opened_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS cases_one_live_per_user
  ON cases(user_id) WHERE status IN ('open', 'monitoring', 'in_review', 'escalated');

CREATE INDEX IF NOT EXISTS cases_status_score_idx
  ON cases(status, score DESC, opened_at DESC);
CREATE INDEX IF NOT EXISTS cases_user_updated_idx
  ON cases(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS monitor_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES subjects(user_id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active',
  started_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz NOT NULL,
  ended_at timestamptz,
  initial_score integer NOT NULL,
  current_score integer NOT NULL,
  peak_score integer NOT NULL,
  event_count integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS monitor_sessions_one_active_per_user
  ON monitor_sessions(user_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS monitor_sessions_active_idx
  ON monitor_sessions(ends_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS monitor_sessions_user_started_idx
  ON monitor_sessions(user_id, started_at DESC)
  INCLUDE (status, ends_at);

CREATE TABLE IF NOT EXISTS risk_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid REFERENCES cases(id) ON DELETE CASCADE,
  session_id uuid REFERENCES monitor_sessions(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES subjects(user_id) ON DELETE CASCADE,
  event_type text NOT NULL,
  source text NOT NULL,
  source_ref text,
  score_delta integer NOT NULL DEFAULT 0,
  score_after integer NOT NULL,
  title text NOT NULL,
  detail text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS risk_events_source_dedupe
  ON risk_events(source, source_ref) WHERE source_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS risk_events_user_time_idx
  ON risk_events(user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS risk_events_session_time_idx
  ON risk_events(session_id, occurred_at) WHERE session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS rule_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  trigger text NOT NULL,
  sequence jsonb NOT NULL DEFAULT '[]'::jsonb,
  exclude_before jsonb NOT NULL DEFAULT '[]'::jsonb,
  window_seconds integer NOT NULL DEFAULT 180,
  score_delta integer NOT NULL DEFAULT 0,
  action_type text NOT NULL DEFAULT 'manual_review',
  action_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  priority integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rule_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id uuid NOT NULL REFERENCES rule_definitions(id) ON DELETE CASCADE,
  case_id uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  session_id uuid REFERENCES monitor_sessions(id) ON DELETE CASCADE,
  evidence jsonb NOT NULL,
  matched_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(rule_id, session_id)
);

CREATE TABLE IF NOT EXISTS staff_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES subjects(user_id) ON DELETE CASCADE,
  action_type text NOT NULL,
  status text NOT NULL,
  actor_id text NOT NULL,
  actor_username text,
  reason text,
  request jsonb,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

INSERT INTO rule_definitions
  (key, name, description, trigger, sequence, exclude_before, window_seconds, score_delta, action_type, priority)
VALUES
  ('reward-rush', 'Reward rush', 'A new account opens two reward packs before depositing.',
   'sequence', '["reward_opened","reward_opened"]'::jsonb, '["fiat_deposit","crypto_deposit","deposit_unclassified"]'::jsonb, 180, 35, 'manual_review', 10),
  ('reward-before-deposit', 'Reward before deposit', 'A new account consumes a reward before any deposit.',
   'sequence', '["reward_opened"]'::jsonb, '["fiat_deposit","crypto_deposit","deposit_unclassified"]'::jsonb, 180, 20, 'manual_review', 20),
  ('signup-bonus-stack', 'Signup bonus stack', 'Multiple bonus/reward credits occur during the signup monitor.',
   'sequence', '["bonus_received","bonus_received"]'::jsonb, '[]'::jsonb, 180, 35, 'manual_review', 30)
ON CONFLICT (key) DO NOTHING;
