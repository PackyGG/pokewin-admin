-- Critical containment remains an at-least-once obligation until it applies.
-- A renewable lease prevents overlapping cron runs from claiming one row;
-- expiration recovers automatically when a worker crashes mid-attempt.
ALTER TABLE antifraud_signals
  ADD COLUMN IF NOT EXISTS containment_outbox_next_attempt_at timestamptz
    NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS containment_outbox_claimed_until timestamptz;

UPDATE antifraud_signals
SET containment_outbox_next_attempt_at = now(),
    containment_outbox_claimed_until = NULL
WHERE containment_outbox_status IN ('pending', 'failed');

DROP INDEX IF EXISTS antifraud_signals_containment_outbox_pending_idx;
CREATE INDEX antifraud_signals_containment_outbox_pending_idx
  ON antifraud_signals (containment_outbox_next_attempt_at, received_at)
  WHERE containment_outbox_status IN ('pending', 'failed');
