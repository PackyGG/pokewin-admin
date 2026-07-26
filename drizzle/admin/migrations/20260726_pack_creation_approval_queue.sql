CREATE TABLE IF NOT EXISTS pack_creation_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'pending',
  requested_by uuid NOT NULL REFERENCES admin_users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  reviewed_by uuid REFERENCES admin_users(id) ON UPDATE CASCADE ON DELETE SET NULL,
  name text NOT NULL,
  slug text NOT NULL,
  requested_active boolean NOT NULL DEFAULT false,
  request_payload jsonb NOT NULL,
  preview_edge numeric(8, 6) NOT NULL,
  preview_win_rate numeric(8, 6) NOT NULL,
  created_pack_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  review_started_at timestamptz,
  reviewed_at timestamptz,
  CONSTRAINT pack_creation_requests_status_check
    CHECK (status IN ('pending', 'processing', 'approved', 'declined')),
  CONSTRAINT pack_creation_requests_payload_object_check
    CHECK (jsonb_typeof(request_payload) = 'object')
);

CREATE INDEX IF NOT EXISTS pack_creation_requests_status_created_idx
  ON pack_creation_requests (status, created_at DESC);

CREATE INDEX IF NOT EXISTS pack_creation_requests_requested_by_created_idx
  ON pack_creation_requests (requested_by, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS pack_creation_requests_pending_slug_key
  ON pack_creation_requests (lower(slug))
  WHERE status IN ('pending', 'processing');
