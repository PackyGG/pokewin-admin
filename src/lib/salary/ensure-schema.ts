import "server-only";

import { adminDb } from "@/lib/admin-db";

// Module-level flag so we only run the CREATE statements once per
// server process. Reset to false on failure so the next caller retries.
let ensured = false;

/**
 * Create the salary_wallet, salary_employees, and salary_payouts
 * tables if they're missing — same self-heal pattern used by /shifts.
 *
 * The proper migration lives at
 * prisma/admin/migrations/20260429300000_add_salary_tables — this is
 * a defensive runtime fallback for environments where that migration
 * hasn't been applied yet (the user has lived through a `migrate dev`
 * disaster on a drifted history; auto-applying via IF NOT EXISTS lets
 * the page Just Work without manual SQL).
 *
 * IF NOT EXISTS makes every statement idempotent. Concurrent first
 * callers race-safely on the ACCESS EXCLUSIVE locks PG takes around
 * CREATE TABLE / CREATE INDEX.
 */
export async function ensureSalarySchema(): Promise<void> {
  if (ensured) return;
  try {
    await adminDb.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "salary_wallet" (
        "id"            TEXT PRIMARY KEY,
        "private_key"   TEXT NOT NULL,
        "network"       TEXT NOT NULL DEFAULT 'ethereum',
        "rpc_url"       TEXT,
        "updated_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
        "updated_by_id" UUID
      )
    `);
    await adminDb.$executeRawUnsafe(`
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
      )
    `);
    await adminDb.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "salary_employees_active_idx"
        ON "salary_employees" ("active")
    `);
    await adminDb.$executeRawUnsafe(`
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
      )
    `);
    await adminDb.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "salary_payouts_employee_id_idx"
        ON "salary_payouts" ("employee_id")
    `);
    await adminDb.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "salary_payouts_status_idx"
        ON "salary_payouts" ("status")
    `);
    await adminDb.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "salary_payouts_created_at_idx"
        ON "salary_payouts" ("created_at" DESC)
    `);
    ensured = true;
  } catch (err) {
    // Reset so the next call retries. Re-throw so the page can
    // distinguish "schema setup failed" from "data missing" and
    // render a friendly error if it happens.
    ensured = false;
    throw err;
  }
}
