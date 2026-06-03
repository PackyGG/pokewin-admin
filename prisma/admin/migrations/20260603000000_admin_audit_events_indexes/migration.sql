-- Performance indexes for the /audit viewer + per-user audit drill-downs.
--
-- The admin_audit_events table currently has only the two composite
-- indexes added in 20260429100000_perf_indexes:
--   • (admin_user_id, created_at DESC)
--   • (event_type, created_at DESC)
-- Neither satisfies (a) an unfiltered ORDER BY created_at DESC LIMIT scan
-- — the headline access pattern of the /audit listing page when no
-- filters are set — nor (b) any access by target_user_id, which is
-- completely uncovered today. The /audit toolbar also filters by
-- `event_type IN (...)` (a multi-value lookup that benefits from a
-- single-column index when the list expands beyond a leading-key match).
--
-- Strictly additive — no column changes, no rename, no drop. Every
-- statement is `IF NOT EXISTS` + `CONCURRENTLY` so re-applying on a
-- partially-applied env is safe AND prod doesn't lock the table while
-- the index builds. Indexed columns + casing match the live schema
-- (snake_case, double-quoted as Prisma emits them).
--
-- Apply on prod via:
--   npx prisma migrate deploy --schema=prisma/admin/schema.prisma \
--     --config=prisma/admin/prisma.config.ts

-- prisma:no-transaction
-- (CREATE INDEX CONCURRENTLY cannot run inside a transaction block.
--  This directive tells Prisma's migration runner to execute this file
--  without wrapping it in BEGIN/COMMIT.)

CREATE INDEX CONCURRENTLY IF NOT EXISTS "admin_audit_events_created_at_idx"
  ON "admin_audit_events" ("created_at" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "admin_audit_events_event_type_idx"
  ON "admin_audit_events" ("event_type");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "admin_audit_events_admin_user_id_idx"
  ON "admin_audit_events" ("admin_user_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "admin_audit_events_target_user_id_idx"
  ON "admin_audit_events" ("target_user_id");
