-- Machine-to-machine API keys for the /api/v1 surface (Discord bot + in-house
-- consumers). See prisma/admin/schema.prisma `model api_keys` for the full
-- security rationale.
--
-- Purely ADDITIVE and idempotent: creates one new table + its indexes and
-- touches nothing else. Written as raw SQL (this repo's prisma/admin/sql
-- convention) rather than `prisma migrate dev` / `db push`, because:
--   • the CLI does not see this schema's migration history from the default
--     path, so `migrate dev` could offer to RESET the admin database, and
--   • several performance indexes exist in the DB but are deliberately
--     UNMODELED in schema.prisma (see admin_audit_events), so a `db push`
--     diff would try to DROP them.
--
-- The plaintext token is NEVER stored: only `prefix` (public) and `key_hash`
-- (SHA-256 of the full token).

CREATE TABLE IF NOT EXISTS "api_keys" (
  "id"                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"               TEXT           NOT NULL,
  "prefix"             TEXT           NOT NULL,
  "key_hash"           TEXT           NOT NULL,
  "scopes"             TEXT[]         NOT NULL DEFAULT '{}',
  "is_active"          BOOLEAN        NOT NULL DEFAULT true,
  "expires_at"         TIMESTAMPTZ(6),
  "last_used_at"       TIMESTAMPTZ(6),
  "last_used_ip"       TEXT,
  "request_count"      INTEGER        NOT NULL DEFAULT 0,
  "rate_limit_per_min" INTEGER        NOT NULL DEFAULT 120,
  "created_by"         UUID,
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "revoked_at"         TIMESTAMPTZ(6),
  "revoked_by"         UUID
);

-- Auth looks the row up by prefix on every request — unique + indexed so it is
-- a single index probe, never a scan over every key.
CREATE UNIQUE INDEX IF NOT EXISTS "api_keys_prefix_key"
  ON "api_keys" ("prefix");

CREATE INDEX IF NOT EXISTS "api_keys_is_active_idx"
  ON "api_keys" ("is_active");

CREATE INDEX IF NOT EXISTS "api_keys_created_at_idx"
  ON "api_keys" ("created_at" DESC);
