-- A user ban is authoritative MAIN state; IP/fingerprint propagation is a
-- separate Antifraud service write. Persist the propagation obligation before
-- remote I/O so an outage cannot cancel the ban or lose the secondary work.
CREATE TABLE IF NOT EXISTS antifraud_identifier_blocking_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_user_id text NOT NULL,
  ip_values jsonb NOT NULL DEFAULT '[]'::jsonb,
  fingerprint_values jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason text NOT NULL,
  actor_id text NOT NULL,
  actor_username text,
  status text NOT NULL DEFAULT 'pending',
  error text,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claimed_until timestamptz,
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT antifraud_identifier_blocking_outbox_status_check
    CHECK (status IN ('pending', 'failed', 'applied')),
  CONSTRAINT antifraud_identifier_blocking_outbox_attempts_check
    CHECK (attempts >= 0),
  CONSTRAINT antifraud_identifier_blocking_outbox_ip_values_check
    CHECK (jsonb_typeof(ip_values) = 'array'),
  CONSTRAINT antifraud_identifier_blocking_outbox_fingerprint_values_check
    CHECK (jsonb_typeof(fingerprint_values) = 'array')
);

CREATE INDEX IF NOT EXISTS antifraud_identifier_blocking_outbox_pending_idx
  ON antifraud_identifier_blocking_outbox (next_attempt_at, created_at)
  WHERE status IN ('pending', 'failed');

CREATE INDEX IF NOT EXISTS antifraud_identifier_blocking_outbox_user_idx
  ON antifraud_identifier_blocking_outbox (target_user_id, created_at DESC);
