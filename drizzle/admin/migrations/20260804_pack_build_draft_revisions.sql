ALTER TABLE pack_creation_requests
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS pack_build_draft_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES pack_creation_requests(id) ON UPDATE CASCADE ON DELETE CASCADE,
  revision integer NOT NULL,
  changed_by uuid REFERENCES admin_users(id) ON UPDATE CASCADE ON DELETE SET NULL,
  change_kind text NOT NULL DEFAULT 'saved',
  name text NOT NULL,
  slug text NOT NULL,
  request_payload jsonb NOT NULL,
  preview_edge numeric(8, 6) NOT NULL,
  preview_win_rate numeric(8, 6) NOT NULL,
  preview_max_win numeric(14, 2),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pack_build_draft_revisions_payload_object_check
    CHECK (jsonb_typeof(request_payload) = 'object'),
  CONSTRAINT pack_build_draft_revisions_request_revision_key
    UNIQUE (request_id, revision)
);

CREATE INDEX IF NOT EXISTS pack_build_draft_revisions_request_created_idx
  ON pack_build_draft_revisions (request_id, created_at DESC);

INSERT INTO pack_build_draft_revisions (
  request_id, revision, changed_by, change_kind, name, slug, request_payload,
  preview_edge, preview_win_rate, preview_max_win, created_at
)
SELECT
  id, revision, requested_by, 'initial', name, slug, request_payload,
  preview_edge, preview_win_rate, preview_max_win, created_at
FROM pack_creation_requests
ON CONFLICT (request_id, revision) DO NOTHING;
