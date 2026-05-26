import "server-only";

import { adminDb } from "@/lib/admin-db";

// Module-level flag so we only run the CREATE statements once per
// server process. Reset to false on failure so the next caller retries.
let ensured = false;

/**
 * Create the employee_workspaces + employee_board_placements tables if
 * they're missing — the same self-heal pattern used by /salaries and
 * /shifts.
 *
 * There is deliberately NO Prisma migration file for these tables: the
 * admin DB has a drifted migration history (the user has lived through
 * a `migrate dev` disaster), so new admin-panel tables are provisioned
 * via this runtime IF-NOT-EXISTS fallback instead of a migration that
 * could conflict.
 *
 * IF NOT EXISTS makes every statement idempotent. Concurrent first
 * callers race-safely on the ACCESS EXCLUSIVE locks PG takes around
 * CREATE TABLE / CREATE INDEX.
 *
 * Referential integrity is enforced at the DB level:
 *   - employee_id  → salary_employees(id) ON DELETE CASCADE
 *     (removing an employee from the salary registry drops their board
 *      placement automatically),
 *   - workspace_id → employee_workspaces(id) ON DELETE SET NULL
 *     (deleting a workspace sends its cards back to "Unassigned").
 *
 * The manager layer adds two more tables:
 *   - employee_managers: an employee promoted to manager (sits in the row
 *     above the columns). employee_id → salary_employees CASCADE.
 *   - employee_manager_workspaces: many-to-many link manager ↔ workspace,
 *     one row per connector line. Both FKs CASCADE, so deleting either a
 *     manager or a workspace drops the corresponding lines.
 */
export async function ensureEmployeeBoardSchema(): Promise<void> {
  if (ensured) return;
  try {
    await adminDb.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "employee_workspaces" (
        "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "name"       TEXT NOT NULL,
        "position"   INTEGER NOT NULL DEFAULT 0,
        "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
      )
    `);
    await adminDb.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "employee_board_placements" (
        "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "employee_id"  UUID NOT NULL
                         REFERENCES "salary_employees"("id") ON DELETE CASCADE,
        "workspace_id" UUID
                         REFERENCES "employee_workspaces"("id") ON DELETE SET NULL,
        "roles"        TEXT[] NOT NULL DEFAULT '{}',
        "position"     INTEGER NOT NULL DEFAULT 0,
        "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
        "updated_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now()
      )
    `);
    await adminDb.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "employee_board_placements_workspace_id_idx"
        ON "employee_board_placements" ("workspace_id")
    `);
    await adminDb.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "employee_board_placements_employee_id_idx"
        ON "employee_board_placements" ("employee_id")
    `);
    // Migrate the v1 single-placement model to the v2 multi-section
    // model. v1 had `employee_id UNIQUE` (one section per employee);
    // v2 allows multiple placements per employee (one per workspace)
    // and enforces uniqueness as `(employee_id, workspace_id)`. Both
    // statements are idempotent — they no-op on fresh installs that
    // never had the v1 constraint, and on already-migrated installs.
    // Postgres' auto-generated UNIQUE constraint name for the
    // original `employee_id UUID NOT NULL UNIQUE` column was
    // `employee_board_placements_employee_id_key`.
    await adminDb.$executeRawUnsafe(`
      ALTER TABLE "employee_board_placements"
        DROP CONSTRAINT IF EXISTS "employee_board_placements_employee_id_key"
    `);
    await adminDb.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "employee_board_placements_employee_id_workspace_id_key"
        ON "employee_board_placements" ("employee_id", "workspace_id")
    `);
    await adminDb.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "employee_managers" (
        "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "employee_id" UUID NOT NULL UNIQUE
                        REFERENCES "salary_employees"("id") ON DELETE CASCADE,
        "position"    INTEGER NOT NULL DEFAULT 0,
        "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
        "updated_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT now()
      )
    `);
    await adminDb.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "employee_manager_workspaces" (
        "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "manager_id"   UUID NOT NULL
                         REFERENCES "employee_managers"("id") ON DELETE CASCADE,
        "workspace_id" UUID NOT NULL
                         REFERENCES "employee_workspaces"("id") ON DELETE CASCADE,
        "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
        CONSTRAINT "employee_manager_workspaces_manager_id_workspace_id_key"
          UNIQUE ("manager_id", "workspace_id")
      )
    `);
    await adminDb.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "employee_manager_workspaces_manager_id_idx"
        ON "employee_manager_workspaces" ("manager_id")
    `);
    await adminDb.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "employee_manager_workspaces_workspace_id_idx"
        ON "employee_manager_workspaces" ("workspace_id")
    `);
    ensured = true;
  } catch (err) {
    // Reset so the next call retries. Re-throw so the caller can
    // distinguish "schema setup failed" from "data missing".
    ensured = false;
    throw err;
  }
}
