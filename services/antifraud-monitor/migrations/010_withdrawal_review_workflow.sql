ALTER TABLE withdrawal_assessments
  ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'unreviewed',
  ADD COLUMN IF NOT EXISTS review_decision text,
  ADD COLUMN IF NOT EXISTS reviewed_by text,
  ADD COLUMN IF NOT EXISTS reviewed_by_username text,
  ADD COLUMN IF NOT EXISTS review_note text,
  ADD COLUMN IF NOT EXISTS review_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS score_breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS flow_checks jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'withdrawal_assessments_review_status_check'
  ) THEN
    ALTER TABLE withdrawal_assessments
      ADD CONSTRAINT withdrawal_assessments_review_status_check
      CHECK (
        review_status IN (
          'unreviewed',
          'in_review',
          'cleared',
          'escalated',
          'block_recommended'
        )
      );
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS withdrawal_review_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  withdrawal_id uuid NOT NULL
    REFERENCES withdrawal_assessments(withdrawal_id) ON DELETE CASCADE,
  action text NOT NULL CHECK (
    action IN ('start_review', 'clear', 'escalate', 'recommend_block')
  ),
  actor_id text NOT NULL,
  actor_username text,
  note text,
  idempotency_key uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS withdrawal_assessments_review_status_requested_idx
  ON withdrawal_assessments (review_status, requested_at DESC);

CREATE INDEX IF NOT EXISTS withdrawal_review_events_withdrawal_created_idx
  ON withdrawal_review_events (withdrawal_id, created_at DESC);
