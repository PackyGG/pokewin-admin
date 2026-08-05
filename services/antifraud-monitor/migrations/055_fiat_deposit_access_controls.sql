CREATE TABLE IF NOT EXISTS fiat_deposit_access_policies (
  id bigserial PRIMARY KEY,
  scope text NOT NULL CHECK (scope IN ('existing_accounts', 'new_signups')),
  generation bigint NOT NULL,
  enabled boolean NOT NULL,
  effective_at timestamptz NOT NULL DEFAULT now(),
  cutoff_at timestamptz,
  actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope, generation)
);

CREATE INDEX IF NOT EXISTS fiat_deposit_access_policies_scope_effective_idx
  ON fiat_deposit_access_policies (scope, effective_at DESC, generation DESC);

CREATE TABLE IF NOT EXISTS fiat_deposit_access_rollouts (
  policy_id bigint PRIMARY KEY REFERENCES fiat_deposit_access_policies(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'complete', 'stalled', 'superseded')),
  cursor_at timestamptz NOT NULL DEFAULT '1970-01-01T00:00:00Z',
  cursor_id text NOT NULL DEFAULT '',
  enqueue_complete boolean NOT NULL DEFAULT false,
  processed_count bigint NOT NULL DEFAULT 0,
  success_count bigint NOT NULL DEFAULT 0,
  failure_count bigint NOT NULL DEFAULT 0,
  last_error text,
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fiat_deposit_access_operations (
  id bigserial PRIMARY KEY,
  policy_id bigint NOT NULL REFERENCES fiat_deposit_access_policies(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('existing_accounts', 'new_signups')),
  user_id text NOT NULL,
  desired_enabled boolean NOT NULL,
  source_created_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'superseded')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  confirmed_enabled boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (policy_id, user_id)
);

CREATE INDEX IF NOT EXISTS fiat_deposit_access_operations_drain_idx
  ON fiat_deposit_access_operations (next_attempt_at, id)
  WHERE status IN ('pending', 'failed');

CREATE TABLE IF NOT EXISTS fiat_deposit_access_cursors (
  stream text PRIMARY KEY,
  occurred_at timestamptz NOT NULL,
  source_id text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);
