-- Per-key IP allowlist for the /api/v1 surface.
--
-- Empty array (the default) = NO restriction, so every existing key keeps
-- working exactly as before. A non-empty list means the key is only accepted
-- when the resolved client IP is one of these.
--
-- Purely ADDITIVE and idempotent. Raw SQL for the same reasons as
-- 2026-07-22_add_api_keys.up.sql (the CLI can't see this schema's migration
-- history from the default path, and several perf indexes are deliberately
-- unmodeled so a `db push` diff would drop them).

ALTER TABLE "api_keys"
  ADD COLUMN IF NOT EXISTS "allowed_ips" TEXT[] NOT NULL DEFAULT '{}';
