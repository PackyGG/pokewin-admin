-- Immutable security boundary log for the repository-contained Antifraud app.
-- This is intentionally separate from the general admin audit stream:
-- authorization attempts, reads, searches and failures must remain append-only
-- even when an operational record is later edited or removed.

CREATE TABLE IF NOT EXISTS antifraud_security_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  correlation_id uuid NOT NULL,
  actor_admin_user_id uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  actor_username text,
  actor_roles text[] NOT NULL DEFAULT '{}'::text[],
  session_hash text,
  model_version text NOT NULL DEFAULT 'security-boundary-v1',
  event_kind text NOT NULL CHECK (
    event_kind IN ('view', 'search', 'export', 'action')
  ),
  action text NOT NULL,
  outcome text NOT NULL CHECK (
    outcome IN ('allowed', 'denied', 'succeeded', 'failed', 'rate_limited')
  ),
  target_type text,
  target_id text,
  reason_code text,
  request_path text,
  request_method text,
  ip_hash text,
  user_agent_hash text,
  idempotency_key_hash text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (length(action) BETWEEN 1 AND 160),
  CHECK (request_path IS NULL OR length(request_path) <= 500),
  CHECK (request_method IS NULL OR length(request_method) <= 12),
  CHECK (target_type IS NULL OR length(target_type) <= 80),
  CHECK (target_id IS NULL OR length(target_id) <= 200),
  CHECK (reason_code IS NULL OR length(reason_code) <= 100)
);

CREATE INDEX IF NOT EXISTS antifraud_security_audit_actor_time_idx
  ON antifraud_security_audit_events(actor_admin_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS antifraud_security_audit_action_time_idx
  ON antifraud_security_audit_events(action, created_at DESC);

CREATE INDEX IF NOT EXISTS antifraud_security_audit_correlation_idx
  ON antifraud_security_audit_events(correlation_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS antifraud_security_audit_outcome_idempotency_idx
  ON antifraud_security_audit_events(action, outcome, idempotency_key_hash)
  WHERE idempotency_key_hash IS NOT NULL
    AND outcome IN ('succeeded', 'failed');

CREATE OR REPLACE FUNCTION reject_antifraud_security_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'antifraud_security_audit_events is append-only'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS antifraud_security_audit_no_update
  ON antifraud_security_audit_events;
CREATE TRIGGER antifraud_security_audit_no_update
  BEFORE UPDATE OR DELETE ON antifraud_security_audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_antifraud_security_audit_mutation();

DROP TRIGGER IF EXISTS antifraud_security_audit_no_truncate
  ON antifraud_security_audit_events;
CREATE TRIGGER antifraud_security_audit_no_truncate
  BEFORE TRUNCATE ON antifraud_security_audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_antifraud_security_audit_mutation();
