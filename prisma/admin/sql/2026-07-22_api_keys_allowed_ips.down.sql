-- Rollback for 2026-07-22_api_keys_allowed_ips.up.sql.
--
-- Drops every configured IP allowlist. Any key that was IP-locked becomes
-- callable from ANY address again, so treat this as a security regression and
-- prefer clearing a single key's list from the UI instead.

ALTER TABLE "api_keys" DROP COLUMN IF EXISTS "allowed_ips";
