-- Reverse of 2026-06-15_add_role_landing_route.up.sql. ADMIN DB ONLY.
-- Drops the additive per-role landing_route column. Safe: the column is
-- nullable with no default and is only consulted as an OVERRIDE (NULL = today's
-- routing), so dropping it restores byte-identical landing behavior. Run:
--   npx prisma db execute --file prisma/admin/sql/2026-06-15_add_role_landing_route.down.sql --config=prisma/admin/prisma.config.ts
ALTER TABLE "admin_roles"
  DROP COLUMN IF EXISTS "landing_route";
