-- Rollback for 2026-07-22_add_api_keys.up.sql.
--
-- DESTRUCTIVE: drops every issued API key. Any Discord bot / script still
-- holding a token starts failing with 401 the moment this runs. Revoking a
-- single key from the /system/api-keys UI is almost always what you want
-- instead — this is only for tearing the whole feature back out.

DROP TABLE IF EXISTS "api_keys";
