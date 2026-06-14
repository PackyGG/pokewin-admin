-- Rollback for the RoleV2 (P0) foundation columns. Fully reversible —
-- allowed_pages / permission_grants / permission_revokes (the runtime gate's
-- source) were never modified, so gate behavior is identical with or without
-- these columns. Dropping system_key also removes the seeded built-in rows'
-- identity, but those rows are not read by the runtime gate (the gate reads
-- admin_users.allowed_pages); the seed can be re-run to recreate them.
-- Run:
--   npx prisma db execute --file prisma/admin/sql/2026-06-14_rolev2_columns.down.sql --config=prisma/admin/prisma.config.ts
DROP INDEX IF EXISTS "admin_roles_system_key_key";

ALTER TABLE "admin_roles"
  DROP COLUMN IF EXISTS "system_key",
  DROP COLUMN IF EXISTS "balance_limit_daily",
  DROP COLUMN IF EXISTS "balance_limit_weekly",
  DROP COLUMN IF EXISTS "balance_limit_monthly",
  DROP COLUMN IF EXISTS "issuance_limit_daily",
  DROP COLUMN IF EXISTS "issuance_limit_weekly",
  DROP COLUMN IF EXISTS "issuance_limit_monthly";
