-- 2026-06-15 — Rollback of the owner / ultra-admin tier column.
-- Drops admin_users.is_owner. Safe: the column carries only the managed
-- owner flag; the permanent ROOT owner `motha` is owner via the code
-- hard-coded bypass, not this column, so dropping it only removes any
-- ADDED owners (everyone reverts to non-owner). Idempotent.
ALTER TABLE admin_users DROP COLUMN IF EXISTS is_owner;
