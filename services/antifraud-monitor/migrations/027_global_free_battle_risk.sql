CREATE TABLE IF NOT EXISTS free_battle_risk_matches (
  participant_id uuid PRIMARY KEY,
  battle_id uuid NOT NULL,
  game_session_id uuid NOT NULL,
  participant_user_id text NOT NULL
    REFERENCES subjects(user_id) ON DELETE CASCADE,
  creator_user_id text NOT NULL,
  creator_username text,
  creator_risk_kind text NOT NULL
    CHECK (creator_risk_kind IN (
      'kyc_rejected',
      'fraud_kyc_required',
      'suspected_alt',
      'antifraud_flagged'
    )),
  creator_risk_detail text NOT NULL,
  risk_points integer NOT NULL CHECK (risk_points IN (40, 80)),
  sponsorship_percentage integer NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS free_battle_risk_matches_user_time_idx
  ON free_battle_risk_matches(participant_user_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS free_battle_risk_matches_creator_time_idx
  ON free_battle_risk_matches(creator_user_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS free_battle_creator_cursors (
  creator_user_id text PRIMARY KEY,
  occurred_at timestamptz NOT NULL,
  source_id uuid NOT NULL,
  creator_risk_kind text NOT NULL
    CHECK (creator_risk_kind IN (
      'kyc_rejected',
      'fraud_kyc_required',
      'suspected_alt',
      'antifraud_flagged'
    )),
  creator_risk_detail text NOT NULL,
  risk_points integer NOT NULL CHECK (risk_points IN (40, 80)),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS free_battle_alert_outbox (
  participant_user_id text NOT NULL
    REFERENCES subjects(user_id) ON DELETE CASCADE,
  alert_level text NOT NULL CHECK (alert_level IN ('high', 'critical')),
  risk_event_id uuid NOT NULL REFERENCES risk_events(id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  delivered_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (participant_user_id, alert_level)
);

CREATE INDEX IF NOT EXISTS free_battle_alert_outbox_pending_idx
  ON free_battle_alert_outbox(next_attempt_at, created_at)
  WHERE delivered_at IS NULL;
