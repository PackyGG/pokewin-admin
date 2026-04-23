"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { adminDb } from "@/lib/admin-db";
import { requirePageAccess } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { ensureShiftsSchema } from "./queries";
import { SHIFTS_PER_DAY } from "./types";

const UUID = z.string().uuid();

const upsertSchema = z.object({
  // ISO 8601 — Monday 00:00 UTC. Validated loosely; fine-grained
  // coercion happens below.
  weekStart: z.string().datetime({ offset: true }),
  dayOfWeek: z.number().int().min(0).max(6),
  shiftSlot: z.number().int().min(0).max(SHIFTS_PER_DAY - 1),
  startAt: z.string().datetime({ offset: true }),
  endAt: z.string().datetime({ offset: true }),
  notes: z.string().trim().max(500).nullable().optional(),
  assignedIds: z.array(UUID).max(20),
});

const deleteSchema = z.object({
  id: UUID,
});

const copySchema = z.object({
  fromWeekStart: z.string().datetime({ offset: true }),
  toWeekStart: z.string().datetime({ offset: true }),
});

// ── Pre-migration ──────────────────────────────────────────────────

function isMissingSchema(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: string }).code;
  if (code === "P2021" || code === "P2022") return true;
  return /(relation .* does not exist|column .* does not exist)/i.test(
    err.message,
  );
}

// ── Actions ────────────────────────────────────────────────────────

/**
 * Create or update the shift for (weekStart, dayOfWeek, shiftSlot).
 * Replaces the full assignment list atomically — any assignments the
 * caller dropped get deleted, new ones get inserted.
 */
export async function upsertShift(
  input: z.infer<typeof upsertSchema>,
): Promise<{ success: true; id: string } | { success: false; error: string }> {
  const session = await requirePageAccess("/shifts");

  const parsed = upsertSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  // Destructure once so the narrowed `data` carries through the inner
  // async helper's closure — TS doesn't propagate the `success: true`
  // narrowing across async function boundaries reliably.
  const data = parsed.data;
  const weekStart = new Date(data.weekStart);
  const startAt = new Date(data.startAt);
  const endAt = new Date(data.endAt);

  if (!(startAt < endAt)) {
    return { success: false, error: "End time must be after start time" };
  }

  async function doUpsert(): Promise<string> {
    // Upsert the shift row by the composite unique key. Prisma supports
    // @@unique composite in where of upsert — we look up first, then
    // update/create. (Prisma's upsert with composite where accepts the
    // auto-generated compound-key type, which is generator-dependent,
    // so a find + branch is less type-fragile.)
    const existing = await adminDb.admin_shifts.findUnique({
      where: {
        week_start_day_of_week_shift_slot: {
          week_start: weekStart,
          day_of_week: data.dayOfWeek,
          shift_slot: data.shiftSlot,
        },
      },
      select: { id: true },
    });

    let shiftId: string;
    if (existing) {
      await adminDb.admin_shifts.update({
        where: { id: existing.id },
        data: {
          start_at: startAt,
          end_at: endAt,
          notes: data.notes ?? null,
        },
        select: { id: true },
      });
      shiftId = existing.id;
    } else {
      const row = await adminDb.admin_shifts.create({
        data: {
          week_start: weekStart,
          day_of_week: data.dayOfWeek,
          shift_slot: data.shiftSlot,
          start_at: startAt,
          end_at: endAt,
          notes: data.notes ?? null,
          created_by_id: session.userId,
        },
        select: { id: true },
      });
      shiftId = row.id;
    }

    // Replace assignments. Simpler than computing a diff for <20 rows.
    await adminDb.$transaction([
      adminDb.admin_shift_assignments.deleteMany({
        where: { shift_id: shiftId },
      }),
      ...(data.assignedIds.length > 0
        ? [
            adminDb.admin_shift_assignments.createMany({
              data: data.assignedIds.map((adminId) => ({
                shift_id: shiftId,
                admin_user_id: adminId,
              })),
              skipDuplicates: true,
            }),
          ]
        : []),
    ]);

    return shiftId;
  }

  try {
    let id: string;
    try {
      id = await doUpsert();
    } catch (err) {
      // Self-heal — tables missing? Create them and retry once.
      if (!isMissingSchema(err)) throw err;
      await ensureShiftsSchema();
      id = await doUpsert();
    }

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "shift_upserted",
      metadata: {
        shiftId: id,
        weekStart: data.weekStart,
        dayOfWeek: data.dayOfWeek,
        shiftSlot: data.shiftSlot,
        assignedCount: data.assignedIds.length,
      },
    });

    revalidatePath("/shifts");
    return { success: true, id };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to save shift",
    };
  }
}

export async function deleteShift(
  id: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requirePageAccess("/shifts");

  const parsed = deleteSchema.safeParse({ id });
  if (!parsed.success) {
    return { success: false, error: "Invalid id" };
  }

  try {
    await adminDb.admin_shifts.delete({
      where: { id: parsed.data.id },
      select: { id: true },
    });

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "shift_deleted",
      metadata: { shiftId: parsed.data.id },
    });

    revalidatePath("/shifts");
    return { success: true };
  } catch (err) {
    if (isMissingSchema(err)) {
      // Nothing to delete — the tables don't exist.
      return { success: true };
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to delete shift",
    };
  }
}

/**
 * Clone every shift from `fromWeekStart` to `toWeekStart`. Times shift
 * by exactly 7 days so a slot that ran 13:00-21:00 UTC last Monday
 * remains 13:00-21:00 UTC on the new Monday. Assignments are copied
 * as-is.
 *
 * Overwrites any existing shifts in the target week for slots that the
 * source has — does NOT touch unrelated slots, so a partial copy is
 * safe (source may be incomplete).
 */
export async function copyWeek(
  input: z.infer<typeof copySchema>,
): Promise<
  | { success: true; copied: number }
  | { success: false; error: string }
> {
  const session = await requirePageAccess("/shifts");

  const parsed = copySchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const fromWeek = new Date(parsed.data.fromWeekStart);
  const toWeek = new Date(parsed.data.toWeekStart);
  // Exact difference in ms — handles DST-safe week shifts because we
  // operate in UTC throughout.
  const weekShiftMs = toWeek.getTime() - fromWeek.getTime();
  if (weekShiftMs === 0) {
    return { success: false, error: "Source and destination are the same week" };
  }

  try {
    // Make sure tables exist before we try to read/write.
    await ensureShiftsSchema().catch(() => {
      /* ignore — subsequent queries will throw with a clearer error */
    });

    const sourceShifts = await adminDb.admin_shifts.findMany({
      where: { week_start: fromWeek },
      select: {
        day_of_week: true,
        shift_slot: true,
        start_at: true,
        end_at: true,
        notes: true,
        assignments: { select: { admin_user_id: true } },
      },
    });

    if (sourceShifts.length === 0) {
      return { success: true, copied: 0 };
    }

    let copied = 0;
    for (const src of sourceShifts) {
      const upserted = await adminDb.admin_shifts.upsert({
        where: {
          week_start_day_of_week_shift_slot: {
            week_start: toWeek,
            day_of_week: src.day_of_week,
            shift_slot: src.shift_slot,
          },
        },
        create: {
          week_start: toWeek,
          day_of_week: src.day_of_week,
          shift_slot: src.shift_slot,
          start_at: new Date(src.start_at.getTime() + weekShiftMs),
          end_at: new Date(src.end_at.getTime() + weekShiftMs),
          notes: src.notes,
          created_by_id: session.userId,
        },
        update: {
          start_at: new Date(src.start_at.getTime() + weekShiftMs),
          end_at: new Date(src.end_at.getTime() + weekShiftMs),
          notes: src.notes,
        },
        select: { id: true },
      });

      await adminDb.$transaction([
        adminDb.admin_shift_assignments.deleteMany({
          where: { shift_id: upserted.id },
        }),
        ...(src.assignments.length > 0
          ? [
              adminDb.admin_shift_assignments.createMany({
                data: src.assignments.map((a) => ({
                  shift_id: upserted.id,
                  admin_user_id: a.admin_user_id,
                })),
                skipDuplicates: true,
              }),
            ]
          : []),
      ]);
      copied += 1;
    }

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "shift_week_copied",
      metadata: {
        from: parsed.data.fromWeekStart,
        to: parsed.data.toWeekStart,
        count: copied,
      },
    });

    revalidatePath("/shifts");
    return { success: true, copied };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to copy week",
    };
  }
}
