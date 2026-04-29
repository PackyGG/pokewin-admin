-- Admin DB performance indexes for hot query paths.
-- Idempotent (IF NOT EXISTS) so a re-run on a partially-applied env is safe.

-- /admin-users → "active sessions" + 2FA tile + last-active.
-- The current "active session" predicate is `expires_at > now() AND
-- logged_out_at IS NULL`. A partial index keyed on the not-null half
-- collapses both to a tiny btree.
CREATE INDEX IF NOT EXISTS admin_sessions_active_partial_idx
  ON admin_sessions (expires_at)
  WHERE logged_out_at IS NULL;

-- /admin-users/[id] audit event tab — paginated by (admin_user_id, created_at DESC).
-- Also speeds the daily-rollup chart on the same page.
CREATE INDEX IF NOT EXISTS admin_audit_events_admin_user_created_idx
  ON admin_audit_events (admin_user_id, created_at DESC);

-- /audit page filters by event_type frequently. Keep a covering index
-- so the filtered ORDER BY can use it directly.
CREATE INDEX IF NOT EXISTS admin_audit_events_event_type_created_idx
  ON admin_audit_events (event_type, created_at DESC);

-- /admin-users/balance-limits overview joins admin_balance_limits → admin_users
-- by admin_user_id. The unique (admin_user_id, period_type) already
-- covers lookups; this btree on `created_at` speeds the default
-- "newest first" sort in getAllLimits.
CREATE INDEX IF NOT EXISTS admin_balance_limits_created_at_idx
  ON admin_balance_limits (created_at DESC);

-- /shifts week board reads by (week_start, day_of_week) — already
-- covered by the (week_start, day_of_week, shift_slot) unique, but
-- the assignment lookup (shift_id) on admin_shift_assignments is
-- worth indexing explicitly.
CREATE INDEX IF NOT EXISTS admin_shift_assignments_shift_id_idx
  ON admin_shift_assignments (shift_id);
