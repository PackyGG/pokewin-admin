"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { adminDb } from "@/lib/admin-db";
import { requireAdmin } from "@/lib/dal";
import {
  getAllLimits,
  getLimitsForAdmin,
  setLimit,
  deleteLimit,
} from "@/lib/balance-limits";

// The Prisma enum is generated, but we mirror it as a string-literal
// union here so the Zod parser doesn't depend on the generated client
// (and so this file compiles cleanly before `admin:migrate`).
const LIMIT_PERIOD = ["daily", "weekly", "monthly"] as const;
type LimitPeriod = (typeof LIMIT_PERIOD)[number];

const setLimitSchema = z.object({
  adminUserId: z.string().uuid("Invalid admin user id"),
  periodType: z.enum(LIMIT_PERIOD),
  // Sanity-check the amount: must be positive, finite, and at or below
  // the column's Decimal(12,2) capacity. Anything bigger is almost
  // certainly a typo and should fail loudly rather than truncate.
  maxAmount: z
    .number()
    .finite()
    .positive("Limit must be greater than zero")
    .max(9_999_999_999.99, "Limit too large"),
});

const deleteLimitSchema = z.object({
  adminUserId: z.string().uuid("Invalid admin user id"),
  periodType: z.enum(LIMIT_PERIOD),
});

/**
 * Verify the target id is an admin_users row before doing anything
 * with `admin_balance_limits.admin_user_id`. Without this check
 * `setLimit` would happily insert a row pointing at a phantom UUID
 * since there's no FK back to admin_users in the schema.
 */
async function assertTargetExists(adminUserId: string): Promise<void> {
  const exists = await adminDb.admin_users.findUnique({
    where: { id: adminUserId },
    select: { id: true },
  });
  if (!exists) {
    throw new Error("Admin user not found");
  }
}

export async function getAdminLimits() {
  await requireAdmin();
  return getAllLimits();
}

export async function getAdminUserLimits(adminUserId: string) {
  await requireAdmin();
  return getLimitsForAdmin(adminUserId);
}

export async function setAdminLimit(data: {
  adminUserId: string;
  periodType: LimitPeriod;
  maxAmount: number;
}): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requireAdmin();

  const parsed = setLimitSchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  try {
    await assertTargetExists(parsed.data.adminUserId);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Invalid target" };
  }

  await setLimit({
    adminUserId: parsed.data.adminUserId,
    periodType: parsed.data.periodType,
    maxAmount: parsed.data.maxAmount,
    setBy: session.userId,
  });

  revalidatePath(`/admin-users/${parsed.data.adminUserId}`);
  return { success: true };
}

export async function deleteAdminLimit(
  adminUserId: string,
  periodType: LimitPeriod,
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requireAdmin();

  const parsed = deleteLimitSchema.safeParse({ adminUserId, periodType });
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  try {
    await deleteLimit(parsed.data.adminUserId, parsed.data.periodType, session.userId);
  } catch (err) {
    // Delete throws on not-found — surface a clean error rather than
    // letting Prisma's "Record to delete does not exist" leak.
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to remove limit",
    };
  }

  revalidatePath(`/admin-users/${parsed.data.adminUserId}`);
  return { success: true };
}
