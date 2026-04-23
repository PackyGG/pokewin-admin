import { adminDb } from "@/lib/admin-db";
import type { Shift, Worker } from "./types";

function isMissingSchema(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: string }).code;
  if (code === "P2021" || code === "P2022") return true;
  return /(relation .* does not exist|column .* does not exist)/i.test(
    err.message,
  );
}

// Module-level flag — we only need to run the ALTER/CREATE once per
// server process. Reset to false on failure so the next caller retries.
let shiftsSchemaEnsured = false;

/**
 * Create the admin_shifts + admin_shift_assignments tables if they're
 * missing. Same rationale as ensureIdeaPositionColumns in /ideas: the
 * app self-heals on first use so ops don't have to run SQL manually.
 *
 * Uses CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS +
 * ADD CONSTRAINT with a try/catch for idempotence — PostgreSQL
 * doesn't have "IF NOT EXISTS" on ADD CONSTRAINT, so a second run
 * after a partial failure would normally error; we catch duplicate-
 * object errors and proceed.
 */
export async function ensureShiftsSchema(): Promise<void> {
  if (shiftsSchemaEnsured) return;

  await adminDb.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "admin_shifts" (
      "id" UUID NOT NULL DEFAULT gen_random_uuid(),
      "week_start" TIMESTAMPTZ(6) NOT NULL,
      "day_of_week" INTEGER NOT NULL,
      "shift_slot" INTEGER NOT NULL,
      "start_at" TIMESTAMPTZ(6) NOT NULL,
      "end_at" TIMESTAMPTZ(6) NOT NULL,
      "notes" TEXT,
      "created_by_id" UUID NOT NULL,
      "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMPTZ(6) NOT NULL,
      CONSTRAINT "admin_shifts_pkey" PRIMARY KEY ("id")
    )
  `);
  await adminDb.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "admin_shifts_week_start_day_of_week_shift_slot_key"
      ON "admin_shifts"("week_start", "day_of_week", "shift_slot")
  `);
  await adminDb.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "admin_shifts_week_start_idx"
      ON "admin_shifts"("week_start")
  `);
  // FK — wrap in try/catch; DO blocks make the check cleaner.
  await adminDb
    .$executeRawUnsafe(
      `DO $$ BEGIN
        ALTER TABLE "admin_shifts"
          ADD CONSTRAINT "admin_shifts_created_by_id_fkey"
          FOREIGN KEY ("created_by_id") REFERENCES "admin_users"("id")
          ON DELETE RESTRICT ON UPDATE CASCADE;
      EXCEPTION WHEN duplicate_object THEN null; END $$;`,
    )
    .catch(() => {
      // Some PG versions surface duplicate_object as a client error
      // rather than letting the EXCEPTION block catch it — ignore.
    });

  await adminDb.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "admin_shift_assignments" (
      "id" UUID NOT NULL DEFAULT gen_random_uuid(),
      "shift_id" UUID NOT NULL,
      "admin_user_id" UUID NOT NULL,
      "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "admin_shift_assignments_pkey" PRIMARY KEY ("id")
    )
  `);
  await adminDb.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "admin_shift_assignments_shift_id_admin_user_id_key"
      ON "admin_shift_assignments"("shift_id", "admin_user_id")
  `);
  await adminDb.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "admin_shift_assignments_admin_user_id_idx"
      ON "admin_shift_assignments"("admin_user_id")
  `);
  await adminDb
    .$executeRawUnsafe(
      `DO $$ BEGIN
        ALTER TABLE "admin_shift_assignments"
          ADD CONSTRAINT "admin_shift_assignments_shift_id_fkey"
          FOREIGN KEY ("shift_id") REFERENCES "admin_shifts"("id")
          ON DELETE CASCADE ON UPDATE CASCADE;
      EXCEPTION WHEN duplicate_object THEN null; END $$;`,
    )
    .catch(() => {});
  await adminDb
    .$executeRawUnsafe(
      `DO $$ BEGIN
        ALTER TABLE "admin_shift_assignments"
          ADD CONSTRAINT "admin_shift_assignments_admin_user_id_fkey"
          FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id")
          ON DELETE CASCADE ON UPDATE CASCADE;
      EXCEPTION WHEN duplicate_object THEN null; END $$;`,
    )
    .catch(() => {});

  shiftsSchemaEnsured = true;
}

/**
 * Load every shift + its assignments for the given ISO week. Returns
 * an empty list if the tables are missing — same defensive pattern as
 * /ideas — and auto-applies the schema so the next call succeeds.
 */
export async function getShiftsForWeek(weekStart: Date): Promise<Shift[]> {
  return getShiftsForWeeks([weekStart]);
}

/**
 * Load every shift + its assignments for a contiguous or arbitrary set
 * of week-start dates in one round trip. Used by the board which
 * renders several weeks stacked together — one query is cheaper than
 * N per-week queries.
 */
export async function getShiftsForWeeks(
  weekStarts: Date[],
): Promise<Shift[]> {
  if (weekStarts.length === 0) return [];
  try {
    const rows = await adminDb.admin_shifts.findMany({
      where: { week_start: { in: weekStarts } },
      select: {
        id: true,
        week_start: true,
        day_of_week: true,
        shift_slot: true,
        start_at: true,
        end_at: true,
        notes: true,
        assignments: {
          select: { admin_user_id: true },
        },
      },
      orderBy: [
        { week_start: "asc" },
        { day_of_week: "asc" },
        { shift_slot: "asc" },
      ],
    });

    return rows.map((r) => ({
      id: r.id,
      weekStart: r.week_start.toISOString(),
      dayOfWeek: r.day_of_week,
      shiftSlot: r.shift_slot,
      startAt: r.start_at.toISOString(),
      endAt: r.end_at.toISOString(),
      notes: r.notes,
      assignedIds: r.assignments.map((a) => a.admin_user_id),
    }));
  } catch (err) {
    if (isMissingSchema(err)) {
      try {
        await ensureShiftsSchema();
      } catch (ensureErr) {
        console.error("[shifts] ensureShiftsSchema failed", ensureErr);
        return [];
      }
      return [];
    }
    throw err;
  }
}

/**
 * Everyone who can be tagged on a shift — active admins and support
 * staff. Creators aren't included because they don't work shifts.
 *
 * Select is explicit so missing profile columns in prod don't crash
 * the page (same defence as elsewhere in the codebase).
 */
export async function getAssignableWorkers(): Promise<Worker[]> {
  const rows = await adminDb.admin_users.findMany({
    where: {
      is_active: true,
      role: { in: ["admin", "support", "marketing"] },
    },
    select: {
      id: true,
      username: true,
      display_username: true,
      role: true,
    },
    orderBy: [{ role: "asc" }, { username: "asc" }],
  });
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    displayUsername: r.display_username ?? null,
    role: r.role,
  }));
}
