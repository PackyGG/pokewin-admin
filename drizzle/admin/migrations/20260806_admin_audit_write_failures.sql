-- Durable fallback for admin audit writes that fail even after retry.
-- The mutation these audit events describe has already committed (e.g. a
-- refund-recovery ban / balance adjustment on MAIN) — this table exists so a
-- transient admin_audit_events write failure never means the audit trail is
-- silently lost. Rows here should be reconciled back into
-- admin_audit_events by hand, then marked resolved.
CREATE TABLE IF NOT EXISTS admin_audit_write_failures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id uuid,
  event_type text NOT NULL,
  target_user_id text,
  ip text,
  metadata jsonb,
  error_message text,
  attempt_count integer NOT NULL DEFAULT 0,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admin_audit_write_failures_attempt_count_check CHECK (attempt_count >= 0)
);

CREATE INDEX IF NOT EXISTS admin_audit_write_failures_unresolved_idx
  ON admin_audit_write_failures (created_at DESC)
  WHERE resolved_at IS NULL;
