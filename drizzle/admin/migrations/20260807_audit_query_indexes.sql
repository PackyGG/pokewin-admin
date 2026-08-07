-- Hot audit-log read paths.
--
-- The security audit viewer is keyset-paginated by (created_at, id). Without
-- this index PostgreSQL parallel-scans and sorts the entire append-only table
-- even for the first 100 rows (124k rows / ~110 MiB at introduction time).
CREATE INDEX IF NOT EXISTS antifraud_security_audit_created_id_idx
  ON antifraud_security_audit_events (created_at DESC, id DESC);

-- These two indexes already exist in the legacy Prisma migration history and
-- are referenced by current query documentation, but were absent from the live
-- ADMIN database after the migration runner moved to drizzle/admin/migrations.
-- They serve the per-operator feed and event-type/time-window feeds directly.
CREATE INDEX IF NOT EXISTS admin_audit_events_admin_user_created_idx
  ON admin_audit_events (admin_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS admin_audit_events_event_type_created_idx
  ON admin_audit_events (event_type, created_at DESC);
