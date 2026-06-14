-- Rollback for the per-user permission override layer. Fully reversible —
-- allowed_pages (the runtime source of truth) was never modified, so gate
-- behavior is identical with or without these columns.
-- Run:
--   npx prisma db execute --file prisma/admin/sql/2026-06-14_add_permission_overrides.down.sql --config=prisma/admin/prisma.config.ts
ALTER TABLE "admin_users"
  DROP COLUMN IF EXISTS "permission_grants",
  DROP COLUMN IF EXISTS "permission_revokes";
