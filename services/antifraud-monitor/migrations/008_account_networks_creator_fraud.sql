CREATE TABLE IF NOT EXISTS analysis_rules (
  key text PRIMARY KEY,
  category text NOT NULL CHECK (category IN ('network', 'creator')),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  points integer NOT NULL CHECK (points BETWEEN -500 AND 500),
  threshold numeric(12,4) NOT NULL CHECK (threshold >= 0),
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO analysis_rules(key, category, name, description, points, threshold)
VALUES
  ('network_shared_ip', 'network', 'Shared signup IP', 'Accounts connected through the same exact signup IP.', 25, 2),
  ('network_shared_device', 'network', 'Shared device', 'Accounts connected through the same Fingerprint visitor ID.', 70, 2),
  ('network_dense_component', 'network', 'Dense account network', 'The connected component contains many accounts.', 30, 5),
  ('network_platform_alt', 'network', 'Platform alt flags', 'One or more connected accounts already carry the platform suspected-alt flag.', 45, 1),
  ('network_proxy_accounts', 'network', 'Proxy or VPN accounts', 'Connected accounts have a positive proxycheck anonymity signal.', 25, 1),
  ('creator_network_accounts', 'creator', 'Connected referred accounts', 'The creator cohort contains accounts that belong to shared IP/device networks.', 25, 3),
  ('creator_external_accounts', 'creator', 'External network members', 'Creator-attributed accounts connect to accounts outside the creator cohort.', 30, 2),
  ('creator_signup_burst', 'creator', 'Affiliate signup burst', 'Many accounts under the creator register inside one hour.', 20, 5),
  ('creator_ip_chain', 'creator', 'Affiliate and IP chain', 'Several creator-attributed accounts share one signup IP.', 50, 3),
  ('creator_country_cluster', 'creator', 'Country concentration', 'A large share of the creator cohort comes from one country.', 15, 60),
  ('creator_proxy_ratio', 'creator', 'Proxy or VPN concentration', 'A large share of assessed creator accounts use anonymous networking.', 25, 25),
  ('creator_disposable_ratio', 'creator', 'Disposable email concentration', 'A large share of creator accounts use disposable email domains.', 35, 20),
  ('creator_wallet_reuse', 'creator', 'Reused deposit wallet', 'Several creator-attributed accounts deposit from the same source wallet.', 45, 2),
  ('creator_synchronized_deposits', 'creator', 'Synchronized deposits', 'Several creator-attributed accounts deposit in the same second.', 35, 2),
  ('creator_ggr_shortfall', 'creator', 'GGR shortfall', 'Attributed cohort actual value trails expected GGR by a material percentage.', 35, 50)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS network_scan_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_kind text NOT NULL CHECK (target_kind IN ('account', 'creator', 'reconciliation')),
  target_id text NOT NULL,
  window_days integer,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  requested_by text,
  error_text text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS network_scan_jobs_one_active_target
  ON network_scan_jobs(target_kind, target_id, COALESCE(window_days, -1))
  WHERE status IN ('pending', 'running');
CREATE INDEX IF NOT EXISTS network_scan_jobs_pending_idx
  ON network_scan_jobs(created_at)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS network_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  root_user_id text NOT NULL,
  network_key text NOT NULL,
  status text NOT NULL DEFAULT 'ready'
    CHECK (status IN ('ready', 'partial', 'failed')),
  raw_score integer NOT NULL DEFAULT 0,
  score integer NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 100),
  severity text NOT NULL DEFAULT 'low'
    CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  signals jsonb NOT NULL DEFAULT '[]'::jsonb,
  node_count integer NOT NULL DEFAULT 0,
  edge_count integer NOT NULL DEFAULT 0,
  account_count integer NOT NULL DEFAULT 0,
  ip_count integer NOT NULL DEFAULT 0,
  device_count integer NOT NULL DEFAULT 0,
  truncated boolean NOT NULL DEFAULT false,
  scanned_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '15 minutes'
);

CREATE INDEX IF NOT EXISTS network_snapshots_root_scanned_idx
  ON network_snapshots(root_user_id, scanned_at DESC);
CREATE INDEX IF NOT EXISTS network_snapshots_key_scanned_idx
  ON network_snapshots(network_key, scanned_at DESC);
CREATE INDEX IF NOT EXISTS network_snapshots_score_scanned_idx
  ON network_snapshots(score DESC, scanned_at DESC);

CREATE TABLE IF NOT EXISTS network_nodes (
  snapshot_id uuid NOT NULL REFERENCES network_snapshots(id) ON DELETE CASCADE,
  node_key text NOT NULL,
  node_type text NOT NULL CHECK (node_type IN ('account', 'ip', 'device')),
  user_id text,
  label text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  degree integer NOT NULL DEFAULT 0,
  PRIMARY KEY(snapshot_id, node_key)
);

CREATE INDEX IF NOT EXISTS network_nodes_user_snapshot_idx
  ON network_nodes(user_id, snapshot_id)
  WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS network_node_secrets (
  snapshot_id uuid NOT NULL,
  node_key text NOT NULL,
  exact_value text NOT NULL,
  PRIMARY KEY(snapshot_id, node_key),
  FOREIGN KEY(snapshot_id, node_key)
    REFERENCES network_nodes(snapshot_id, node_key) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS network_edges (
  snapshot_id uuid NOT NULL REFERENCES network_snapshots(id) ON DELETE CASCADE,
  source_key text NOT NULL,
  target_key text NOT NULL,
  edge_type text NOT NULL CHECK (edge_type IN ('shared_ip', 'shared_device')),
  PRIMARY KEY(snapshot_id, source_key, target_key, edge_type)
);

CREATE INDEX IF NOT EXISTS network_edges_snapshot_source_idx
  ON network_edges(snapshot_id, source_key);
CREATE INDEX IF NOT EXISTS network_edges_snapshot_target_idx
  ON network_edges(snapshot_id, target_key);

CREATE TABLE IF NOT EXISTS creator_fraud_assessments (
  creator_user_id text NOT NULL,
  window_key text NOT NULL,
  codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  raw_score integer NOT NULL DEFAULT 0,
  score integer NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 100),
  severity text NOT NULL DEFAULT 'low'
    CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,
  signals jsonb NOT NULL DEFAULT '[]'::jsonb,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  partial boolean NOT NULL DEFAULT false,
  assessed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(creator_user_id, window_key)
);

CREATE INDEX IF NOT EXISTS creator_fraud_assessments_window_score_idx
  ON creator_fraud_assessments(window_key, score DESC, assessed_at DESC);

ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS subject_type text NOT NULL DEFAULT 'account',
  ADD COLUMN IF NOT EXISTS network_key text,
  ADD COLUMN IF NOT EXISTS network_snapshot_id uuid REFERENCES network_snapshots(id) ON DELETE SET NULL;

ALTER TABLE cases DROP CONSTRAINT IF EXISTS cases_subject_type_check;
ALTER TABLE cases ADD CONSTRAINT cases_subject_type_check
  CHECK (subject_type IN ('account', 'network'));

DROP INDEX IF EXISTS cases_one_live_per_user;
CREATE UNIQUE INDEX IF NOT EXISTS cases_one_live_per_user
  ON cases(user_id)
  WHERE subject_type = 'account'
    AND status IN ('open', 'monitoring', 'in_review', 'escalated');
CREATE UNIQUE INDEX IF NOT EXISTS cases_one_live_per_network
  ON cases(network_key)
  WHERE subject_type = 'network'
    AND network_key IS NOT NULL
    AND status IN ('open', 'monitoring', 'in_review', 'escalated');

CREATE TABLE IF NOT EXISTS network_case_members (
  case_id uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  is_root boolean NOT NULL DEFAULT false,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(case_id, user_id)
);

CREATE INDEX IF NOT EXISTS network_case_members_user_idx
  ON network_case_members(user_id, case_id);
