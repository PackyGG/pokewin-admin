-- RoleV2 (P0) — admin role rebuild foundation: make the six built-in roles
-- first-class rows in admin_roles + add the typed per-role limit slots.
-- ADDITIVE + REVERSIBLE. Apply to the ADMIN DB ONLY (db-push-managed).
-- Run:
--   npx prisma db execute --file prisma/admin/sql/2026-06-14_rolev2_columns.up.sql --config=prisma/admin/prisma.config.ts
-- Does NOT touch allowed_pages, permission_grants/revokes, the admin_role
-- enum's MEMBERS, admin_users, or the MAIN game DB. Behavior-neutral: only
-- adds columns (all NULL on existing rows) + a unique index on system_key.
--
-- system_key reuses the existing admin_role enum type (already defined in the
-- admin DB) — no new type, no enum mutation. Postgres treats multiple NULLs as
-- distinct under a UNIQUE index, so existing custom roles (system_key = NULL)
-- never collide; only the six seeded built-in rows carry a non-NULL value.
ALTER TABLE "admin_roles"
  ADD COLUMN IF NOT EXISTS "system_key" "admin_role",
  ADD COLUMN IF NOT EXISTS "balance_limit_daily"    numeric(12,2),
  ADD COLUMN IF NOT EXISTS "balance_limit_weekly"   numeric(12,2),
  ADD COLUMN IF NOT EXISTS "balance_limit_monthly"  numeric(12,2),
  ADD COLUMN IF NOT EXISTS "issuance_limit_daily"   numeric(12,2),
  ADD COLUMN IF NOT EXISTS "issuance_limit_weekly"  numeric(12,2),
  ADD COLUMN IF NOT EXISTS "issuance_limit_monthly" numeric(12,2);

-- Regular UNIQUE index (named to match Prisma's `@unique` convention so the
-- schema mirror and the live DB agree). Multiple NULLs allowed → custom roles
-- with NULL system_key are fine.
CREATE UNIQUE INDEX IF NOT EXISTS "admin_roles_system_key_key"
  ON "admin_roles" ("system_key");
