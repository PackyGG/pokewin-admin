-- One ADMIN audit mirror per antifraud command. The browser retries the same
-- UUID after a partial failure, so both the monitor decision and review status
-- paths can safely re-attempt their audit insert.
CREATE UNIQUE INDEX IF NOT EXISTS admin_audit_antifraud_idempotency_idx
  ON admin_audit_events ((metadata ->> 'idempotencyKey'))
  WHERE event_type IN (
    'antifraud_monitor_case_decision',
    'antifraud_review_status_changed'
  )
    AND metadata ? 'idempotencyKey';
