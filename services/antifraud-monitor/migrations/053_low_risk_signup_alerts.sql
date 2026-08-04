-- Signup scores 21–49 now produce their own configurable Discord action.
-- Existing rows are not backfilled, preventing a historical notification burst.

ALTER TABLE signup_alert_outbox
  DROP CONSTRAINT IF EXISTS signup_alert_outbox_score_check;

ALTER TABLE signup_alert_outbox
  ADD CONSTRAINT signup_alert_outbox_score_check CHECK (score >= 21);
