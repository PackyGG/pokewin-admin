CREATE TABLE IF NOT EXISTS creator_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  target_user_id text,
  alert_type text NOT NULL,
  dedupe_key text NOT NULL,
  severity text DEFAULT 'info' NOT NULL,
  metadata jsonb,
  read_at timestamptz(6),
  read_by uuid,
  dismissed_at timestamptz(6),
  dismissed_by uuid,
  created_at timestamptz(6) DEFAULT now() NOT NULL,
  updated_at timestamptz(6) DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS creator_alerts_dedupe_key_key
  ON creator_alerts (dedupe_key);
CREATE INDEX IF NOT EXISTS creator_alerts_active_idx
  ON creator_alerts (dismissed_at, severity, created_at DESC);
CREATE INDEX IF NOT EXISTS creator_alerts_target_user_idx
  ON creator_alerts (target_user_id);

CREATE TABLE IF NOT EXISTS creator_session_meta (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  session_id text NOT NULL,
  target_user_id text NOT NULL,
  kick_vod_url text,
  notes text,
  updated_by uuid,
  created_at timestamptz(6) DEFAULT now() NOT NULL,
  updated_at timestamptz(6) DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS creator_session_meta_session_id_key
  ON creator_session_meta (session_id);
CREATE INDEX IF NOT EXISTS creator_session_meta_target_user_idx
  ON creator_session_meta (target_user_id);
