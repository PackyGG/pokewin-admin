-- Phase D — real session revocation. ADDITIVE + REVERSIBLE. ADMIN DB ONLY.
-- Run:
--   npx prisma db execute --file prisma/admin/sql/2026-06-14_add_sessions_valid_after.up.sql --config=prisma/admin/prisma.config.ts
-- Nullable, no default: NULL = no forced revocation (all sessions valid).
-- verifySession compares the JWT's issued-at (iat) against this timestamp;
-- "force-expire sessions" sets it to now(). Touches no game DB, no enum.
ALTER TABLE "admin_users"
  ADD COLUMN IF NOT EXISTS "sessions_valid_after" timestamptz;
