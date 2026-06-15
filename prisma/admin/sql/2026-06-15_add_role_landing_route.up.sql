-- RoleV2 (P4) — per-role landing route. ADDITIVE + REVERSIBLE. ADMIN DB ONLY.
-- Apply to the ADMIN DB (db-push-managed) via:
--   npx prisma db execute --file prisma/admin/sql/2026-06-15_add_role_landing_route.up.sql --config=prisma/admin/prisma.config.ts
--
-- Single additive nullable column on admin_roles. NULL on every existing row
-- (no default, no backfill) = today's routing (getDefaultRouteForRoles
-- fallback) — strictly behavior-neutral until an admin sets one. When set AND
-- valid (a known ADMIN_PAGES key, validated in code against ALL_PAGE_KEYS), a
-- NON-admin holder of this role lands there after auth. `admin` is excluded in
-- code (hard bypass → /dashboard). Touches NO other column, NO enum, NO
-- allowed_pages, and NOT the MAIN game DB. Adding a nullable column with no
-- default is an instant metadata-only change (Postgres 11+).
ALTER TABLE "admin_roles"
  ADD COLUMN IF NOT EXISTS "landing_route" text;
