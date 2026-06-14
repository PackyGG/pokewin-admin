-- Phase C — admin role rebuild: explicit per-user permission override layer.
-- ADDITIVE + REVERSIBLE. Apply to the ADMIN DB ONLY (db-push-managed).
-- Run:
--   npx prisma db execute --file prisma/admin/sql/2026-06-14_add_permission_overrides.up.sql --config=prisma/admin/prisma.config.ts
-- Does NOT touch allowed_pages, the admin_role enum, or the MAIN game DB.
-- Adds two array columns defaulting to empty; existing rows backfill to '{}'
-- as an instant metadata-only change (Postgres 11+). No access changes.
ALTER TABLE "admin_users"
  ADD COLUMN IF NOT EXISTS "permission_grants"  text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "permission_revokes" text[] NOT NULL DEFAULT '{}';
