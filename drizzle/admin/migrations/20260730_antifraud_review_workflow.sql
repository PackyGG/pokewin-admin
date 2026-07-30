-- Additive staff-workflow projection for Account Reviews.
-- Detection remains owned by Antifraud and MAIN remains a read-only source.

CREATE TABLE IF NOT EXISTS antifraud_review_workflow (
  review_id UUID PRIMARY KEY
    REFERENCES antifraud_reviews(id) ON DELETE CASCADE,
  queue_state TEXT NOT NULL DEFAULT 'normal',
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  postponed_until TIMESTAMPTZ(6),
  postponed_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  state_updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT antifraud_review_workflow_state_check
    CHECK (queue_state IN ('priority', 'normal', 'waiting_kyc'))
);

INSERT INTO antifraud_review_workflow (review_id, queue_state)
SELECT id, 'normal'
FROM antifraud_reviews
ON CONFLICT (review_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS antifraud_review_workflow_queue_idx
  ON antifraud_review_workflow (queue_state, review_id);

CREATE INDEX IF NOT EXISTS antifraud_review_workflow_postponed_idx
  ON antifraud_review_workflow (postponed_until, review_id)
  WHERE postponed_until IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS admin_audit_review_postponed_idempotency_idx
  ON admin_audit_events ((metadata ->> 'idempotencyKey'))
  WHERE event_type = 'antifraud_review_postponed'
    AND metadata ? 'idempotencyKey';
