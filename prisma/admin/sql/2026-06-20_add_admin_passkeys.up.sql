-- 2026-06-20 — Passkey (WebAuthn) second-factor credentials (ADMIN DB only).
-- Each row is one registered passkey for an admin_user, usable as an
-- alternative to the TOTP code at the 2FA verification step. Password (factor
-- one) and TOTP enrollment are unchanged — this is purely additive.
-- Provisioned via `prisma db execute` (the admin DB is db-push/execute-managed
-- with a drifted migration history; NOT `migrate`). Idempotent: CREATE ... IF
-- NOT EXISTS only. Touches ONLY this one new table. No ALTER/DROP elsewhere.
-- The Prisma model block (model admin_passkeys in prisma/admin/schema.prisma)
-- is the typed mirror.
CREATE TABLE IF NOT EXISTS "admin_passkeys" (
  "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "admin_user_id" UUID NOT NULL REFERENCES "admin_users"("id") ON DELETE CASCADE,
  "credential_id" TEXT NOT NULL UNIQUE,
  "public_key"    BYTEA NOT NULL,
  "counter"       BIGINT NOT NULL DEFAULT 0,
  "transports"    TEXT[] NOT NULL DEFAULT '{}',
  "device_name"   TEXT,
  "backed_up"     BOOLEAN NOT NULL DEFAULT false,
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "last_used_at"  TIMESTAMPTZ(6)
);
CREATE INDEX IF NOT EXISTS "admin_passkeys_admin_user_id_idx" ON "admin_passkeys" ("admin_user_id");
