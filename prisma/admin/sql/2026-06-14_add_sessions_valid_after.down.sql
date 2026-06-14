-- Rollback for the session-revocation timestamp. Fully reversible.
-- Run:
--   npx prisma db execute --file prisma/admin/sql/2026-06-14_add_sessions_valid_after.down.sql --config=prisma/admin/prisma.config.ts
ALTER TABLE "admin_users"
  DROP COLUMN IF EXISTS "sessions_valid_after";
