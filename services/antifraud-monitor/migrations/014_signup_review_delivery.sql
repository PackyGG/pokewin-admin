CREATE TABLE IF NOT EXISTS signup_alert_outbox (
  user_id text PRIMARY KEY REFERENCES subjects(user_id) ON DELETE CASCADE,
  case_id uuid REFERENCES cases(id) ON DELETE SET NULL,
  username text,
  score integer NOT NULL CHECK (score >= 60),
  signals jsonb NOT NULL DEFAULT '[]'::jsonb,
  occurred_at timestamptz NOT NULL,
  discord_delivered_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS signup_alert_outbox_pending_idx
  ON signup_alert_outbox (next_attempt_at, created_at)
  WHERE discord_delivered_at IS NULL;

-- Recover every already-assessed score-60 signup. The monitor will retry the
-- Discord row, while migration 013's signed risk-event cursor delivers the
-- marker below to Account Review.
INSERT INTO signup_alert_outbox (
  user_id, case_id, username, score, signals, occurred_at
)
SELECT
  sa.user_id,
  latest_case.id,
  s.username,
  sa.score,
  sa.signals,
  s.source_created_at
FROM signup_assessments sa
JOIN subjects s ON s.user_id = sa.user_id
LEFT JOIN LATERAL (
  SELECT c.id
  FROM cases c
  WHERE c.user_id = sa.user_id
    AND c.subject_type = 'account'
  ORDER BY c.updated_at DESC, c.id DESC
  LIMIT 1
) latest_case ON true
WHERE sa.score >= 60
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO risk_events (
  case_id, session_id, user_id, event_type, source, source_ref,
  score_delta, score_after, title, detail, payload, occurred_at
)
SELECT
  latest_case.id,
  latest_session.id,
  sa.user_id,
  'high_risk_signup',
  'signup_alert',
  sa.user_id || ':high_risk_signup',
  0,
  sa.score,
  'High-risk signup',
  format('Signup scored %s points and needs account review.', sa.score),
  jsonb_build_object(
    'monitorCaseId', latest_case.id,
    'signals', sa.signals
  ),
  s.source_created_at
FROM signup_assessments sa
JOIN subjects s ON s.user_id = sa.user_id
LEFT JOIN LATERAL (
  SELECT c.id
  FROM cases c
  WHERE c.user_id = sa.user_id
    AND c.subject_type = 'account'
  ORDER BY c.updated_at DESC, c.id DESC
  LIMIT 1
) latest_case ON true
LEFT JOIN LATERAL (
  SELECT ms.id
  FROM monitor_sessions ms
  WHERE ms.user_id = sa.user_id
    AND (latest_case.id IS NULL OR ms.case_id = latest_case.id)
  ORDER BY ms.started_at DESC, ms.id DESC
  LIMIT 1
) latest_session ON true
WHERE sa.score >= 60
ON CONFLICT (source, source_ref) WHERE source_ref IS NOT NULL
DO NOTHING;
