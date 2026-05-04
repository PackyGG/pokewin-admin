-- Employee salary auto-pay infrastructure (motha-only).
-- Idempotent: every CREATE uses IF NOT EXISTS.

-- Singleton wallet config row (id = literal 'singleton').
CREATE TABLE IF NOT EXISTS "salary_wallet" (
  "id"            TEXT PRIMARY KEY,
  "private_key"   TEXT NOT NULL,
  "network"       TEXT NOT NULL DEFAULT 'ethereum',
  "rpc_url"       TEXT,
  "updated_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_by_id" UUID
);

CREATE TABLE IF NOT EXISTS "salary_employees" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"           TEXT NOT NULL,
  "eth_address"    TEXT NOT NULL,
  "salary_usdt"    NUMERIC(20, 6) NOT NULL,
  "max_per_payout" NUMERIC(20, 6),
  "active"         BOOLEAN NOT NULL DEFAULT true,
  "last_paid_at"   TIMESTAMPTZ(6),
  "notes"          TEXT,
  "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "created_by_id"  UUID NOT NULL REFERENCES "admin_users"("id")
);

CREATE INDEX IF NOT EXISTS "salary_employees_active_idx"
  ON "salary_employees" ("active");

CREATE TABLE IF NOT EXISTS "salary_payouts" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "employee_id"    UUID NOT NULL REFERENCES "salary_employees"("id"),
  "amount_usdt"    NUMERIC(20, 6) NOT NULL,
  "to_address"     TEXT NOT NULL,
  "tx_hash"        TEXT UNIQUE,
  "status"         TEXT NOT NULL DEFAULT 'pending',
  "error_message"  TEXT,
  "broadcast_at"   TIMESTAMPTZ(6),
  "confirmed_at"   TIMESTAMPTZ(6),
  "failed_at"      TIMESTAMPTZ(6),
  "paid_by_id"     UUID NOT NULL REFERENCES "admin_users"("id"),
  "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "salary_payouts_employee_id_idx"
  ON "salary_payouts" ("employee_id");

CREATE INDEX IF NOT EXISTS "salary_payouts_status_idx"
  ON "salary_payouts" ("status");

CREATE INDEX IF NOT EXISTS "salary_payouts_created_at_idx"
  ON "salary_payouts" ("created_at" DESC);
