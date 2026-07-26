"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireAntifraudManager } from "@/lib/require-antifraud-access";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { awardStaffPoints } from "@/lib/antifraud/profile";

/**
 * Manual points adjustments — OWNER / ADMIN ONLY.
 *
 * Quizzes pay automatically; this is the human override for everything else
 * ("caught the multi-account ring", "cleared the weekend backlog"), and for
 * correcting a mistake.
 *
 * A correction is a NEGATIVE award, never an edit: `staff_point_events` is
 * append-only, so the history stays auditable and the profile roll-up is always
 * the sum of what actually happened.
 */

const awardSchema = z.object({
  adminUserId: z.string().uuid("Pick a staff member"),
  points: z.coerce
    .number()
    .int("Points must be a whole number")
    .refine((v) => v !== 0, "Use a non-zero amount")
    .refine((v) => Math.abs(v) <= 500, "Keep adjustments under 500 points"),
  reason: z
    .string()
    .trim()
    .min(3, "Say what this is for")
    .max(200, "Keep the reason under 200 characters"),
});

export async function awardPointsManually(input: unknown): Promise<void> {
  const session = await requireAntifraudManager();
  const parsed = awardSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const { adminUserId, points, reason } = parsed.data;

  const result = await awardStaffPoints({
    adminUserId,
    points,
    sourceKind: "manual",
    reason,
    createdBy: session.userId,
  });
  if (!result.ok) {
    throw new Error("Could not record the adjustment");
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "antifraud_points_adjusted",
    metadata: {
      staffAdminUserId: adminUserId,
      points,
      reason,
      newTotal: result.pointsTotal,
    },
  });

  revalidatePath("/antifraud/staff");
  revalidatePath("/antifraud/settings/points");
  revalidatePath("/antifraud/profile");
  revalidatePath("/antifraud");
}
