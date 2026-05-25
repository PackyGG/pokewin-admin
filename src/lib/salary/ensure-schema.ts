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
    // salary_wallet was for the now-removed auto-payment system;
    // we DROP it here so an env where the original migration ran
    // self-cleans, then create the registry tables.
    await adminDb.$executeRawUnsafe(`
      DROP TABLE IF EXISTS "salary_wallet"
    `);
    await adminDb.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "salary_employees" (
        "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "discord_name"   TEXT NOT NULL,
        "eth_address"    TEXT NOT NULL,
        "cadence"        TEXT NOT NULL DEFAULT 'monthly',
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
    // Upgrade partial-env tables that were created before the
    // discord_name + cadence columns existed. ADD COLUMN IF NOT EXISTS
    // is idempotent; the rename is gated on column-existence so
    // re-runs are no-ops.
    await adminDb.$executeRawUnsafe(`
      ALTER TABLE "salary_employees"
        ADD COLUMN IF NOT EXISTS "cadence" TEXT NOT NULL DEFAULT 'monthly'
    `);
    // Optional recurring pay day. pay_day_of_week (0=Sun…6=Sat) is the
    // legacy weekday column — kept for back-compat but no longer used by
    // the UI. pay_day_of_month (1-31) is the current setting: the day of
    // the month the employee is paid (clamped to month length at render).
    // Both nullable — no pay day = no due/ok badge.
    await adminDb.$executeRawUnsafe(`
      ALTER TABLE "salary_employees"
        ADD COLUMN IF NOT EXISTS "pay_day_of_week" SMALLINT
    `);
    await adminDb.$executeRawUnsafe(`
      ALTER TABLE "salary_employees"
        ADD COLUMN IF NOT EXISTS "pay_day_of_month" SMALLINT
    `);
    await adminDb.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'salary_employees'
            AND column_name = 'name'
        )
        AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'salary_employees'
            AND column_name = 'discord_name'
        )
        THEN
          ALTER TABLE "salary_employees" RENAME COLUMN "name" TO "discord_name";
        END IF;
      END $$
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
    // Lightweight payment tracking: a saved payment link per employee
    // with a date. Separate from the (legacy, unused) salary_payouts
    // table — this is just "who got paid, link, when". CASCADE so
    // removing an employee clears their records.
    await adminDb.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "salary_payments" (
        "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "employee_id"   UUID NOT NULL
                          REFERENCES "salary_employees"("id") ON DELETE CASCADE,
        "payment_link"  TEXT NOT NULL,
        "paid_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
        "created_by_id" UUID NOT NULL REFERENCES "admin_users"("id"),
        "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now()
      )
    `);
    await adminDb.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "salary_payments_employee_id_idx"
        ON "salary_payments" ("employee_id")
    `);
    await adminDb.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "salary_payments_paid_at_idx"
        ON "salary_payments" ("paid_at" DESC)
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
