CREATE TABLE IF NOT EXISTS reward_abuse_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_user_id text NOT NULL,
  target_username text,
  detector text NOT NULL DEFAULT 'rain_farming',
  detector_version text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  score integer NOT NULL,
  severity text NOT NULL,
  window_started_at timestamptz NOT NULL,
  window_ended_at timestamptz NOT NULL,
  metrics jsonb NOT NULL,
  reasons text[] NOT NULL DEFAULT '{}',
  first_detected_at timestamptz NOT NULL DEFAULT now(),
  last_detected_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  review_reason text,
  reviewed_at timestamptz,
  rain_lock_applied boolean NOT NULL DEFAULT false,
  discord_alerted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reward_abuse_reviews_status_check
    CHECK (status IN ('pending', 'confirmed', 'dismissed')),
  CONSTRAINT reward_abuse_reviews_severity_check
    CHECK (severity IN ('medium', 'high', 'critical')),
  CONSTRAINT reward_abuse_reviews_score_check CHECK (score BETWEEN 0 AND 100),
  CONSTRAINT reward_abuse_reviews_window_check CHECK (window_ended_at > window_started_at),
  CONSTRAINT reward_abuse_reviews_metrics_check CHECK (jsonb_typeof(metrics) = 'object'),
  CONSTRAINT reward_abuse_reviews_review_shape_check CHECK (
    (status = 'pending' AND reviewed_by IS NULL AND reviewed_at IS NULL)
    OR
    (status <> 'pending' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL
      AND review_reason IS NOT NULL AND char_length(btrim(review_reason)) >= 3)
  )
);

ALTER TABLE reward_abuse_reviews
  ADD COLUMN IF NOT EXISTS discord_alerted_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS reward_abuse_reviews_pending_user_detector_uniq
  ON reward_abuse_reviews (target_user_id, detector)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS reward_abuse_reviews_status_score_idx
  ON reward_abuse_reviews (status, score DESC, last_detected_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS reward_abuse_reviews_user_idx
  ON reward_abuse_reviews (target_user_id, last_detected_at DESC);

INSERT INTO discord_notification_events (
  event_key, label, description, category, is_custom, enabled
)
VALUES (
  'antifraud.reward_abuse_rain',
  'Rain reward abuse',
  'Batched alerts when the rain-farming detector adds accounts for manual review.',
  'Rewards',
  false,
  true
)
ON CONFLICT (event_key) DO UPDATE SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  category = EXCLUDED.category,
  enabled = true,
  updated_at = now();
