-- 2026-06-15 — Owner / ultra-admin tier.
-- Adds the additive `is_owner` flag to admin_users (ADMIN DB only).
-- An owner bypasses every page + capability check AND the owner-only
-- surfaces. Permanent ROOT owner `motha` is owner via a hard-coded bypass
-- in src/lib/owners.ts, so NO row write is needed to seed it — every
-- existing row stays a non-owner (DEFAULT false). Idempotent.
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS is_owner boolean NOT NULL DEFAULT false;
