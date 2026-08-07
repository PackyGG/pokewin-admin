// =============================================================================
// role-limits-actions.ts — the mutating server action for per-ROLE limits
// (RoleV2 P3). Split out from `role-limits.ts` because a `"use server"` module
// may only export async functions; the pure merge + read helpers live in
// `role-limits.ts`. Mirrors the existing balance-limits split
// (balance-limits.ts ↔ admin-users/limits-actions.ts).
//
// `setRoleLimits` is `requireAdmin` + `require2FA` gated and audited as
// `admin_role_limits_updated`. It does NOT re-materialize `allowed_pages` —
// per-role limits are enforced LIVE at spend time (checkBalanceAdjustmentLimit
// in balance-limits.ts), not baked into the materialized page list. Built for
// P4's editor UI to call; no UI is built in this phase.
// =============================================================================

"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { adminDrizzle } from "@/lib/admin-db";
import { admin_roles } from "@/lib/db-schema/admin/schema";
import { requireAdmin } from "@/lib/dal";
import { require2FA } from "@/lib/require-2fa";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { getRoleLimits } from "@/lib/role-limits";
import type { RoleLimits } from "@/lib/permissions/types";

// A single limit slot: a positive amount within the Decimal(12,2) capacity, or
// `null` to clear the cap, or omitted to leave the column unchanged. Same
// capacity guard as `admin-users/limits-actions.ts`'s per-user `maxAmount`.
const limitSlot = z
  .number()
  .finite()
  .positive("Limit must be greater than zero")
  .max(9_999_999_999.99, "Limit too large")
  .nullable()
  .optional();

const periodGroup = z
  .object({ daily: limitSlot, weekly: limitSlot, monthly: limitSlot })
  .optional();

const setRoleLimitsSchema = z.object({
  roleId: z.string().uuid("Invalid role id"),
  limits: z.object({
    balanceAdjustment: periodGroup,
    issuance: periodGroup,
  }),
});

type SetRoleLimitsInput = {
  balanceAdjustment?: Partial<RoleLimits["balanceAdjustment"]>;
  issuance?: Partial<NonNullable<RoleLimits["issuance"]>>;
};

/**
 * Write a role's limit columns. Each provided slot may be a positive number (a
 * cap) or `null` (clear the cap); omitted slots are left unchanged. For P4's
 * editor — read the current values with `getRoleLimits(roleId)`.
 */
export async function setRoleLimits(
  roleId: string,
  limits: SetRoleLimitsInput,
  code: string | undefined,
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requireAdmin();

  const parsed = setRoleLimitsSchema.safeParse({ roleId, limits });
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  try {
    await require2FA(session.userId, code);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "2FA required" };
  }

  // Validate the role exists (no FK self-check otherwise — a phantom id would
  // throw an opaque database error on update).
  const [role] = await adminDrizzle.select({
    id: admin_roles.id, name: admin_roles.name, system_key: admin_roles.system_key,
  }).from(admin_roles).where(eq(admin_roles.id, parsed.data.roleId)).limit(1);
  if (!role) return { success: false, error: "Role not found" };

  // Map the validated partial onto the six columns. A slot present in the
  // input (number or explicit null) is written; an omitted slot is skipped.
  const data: Partial<typeof admin_roles.$inferInsert> = {};
  const ba = parsed.data.limits.balanceAdjustment;
  if (ba) {
    if (ba.daily !== undefined) data.balance_limit_daily = ba.daily === null ? null : String(ba.daily);
    if (ba.weekly !== undefined) data.balance_limit_weekly = ba.weekly === null ? null : String(ba.weekly);
    if (ba.monthly !== undefined) data.balance_limit_monthly = ba.monthly === null ? null : String(ba.monthly);
  }
  const iss = parsed.data.limits.issuance;
  if (iss) {
    if (iss.daily !== undefined) data.issuance_limit_daily = iss.daily === null ? null : String(iss.daily);
    if (iss.weekly !== undefined) data.issuance_limit_weekly = iss.weekly === null ? null : String(iss.weekly);
    if (iss.monthly !== undefined) data.issuance_limit_monthly = iss.monthly === null ? null : String(iss.monthly);
  }
  if (Object.keys(data).length === 0) {
    return { success: false, error: "No limit fields provided" };
  }

  await adminDrizzle.update(admin_roles).set(data)
    .where(eq(admin_roles.id, parsed.data.roleId));

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "admin_role_limits_updated",
    metadata: {
      roleId: parsed.data.roleId,
      roleName: role.name,
      systemKey: role.system_key ?? null,
      // Record exactly which columns were written and to what.
      changes: data,
    },
  });

  // The role editor surfaces (admin-users role views) re-read on revalidate.
  revalidatePath("/admin-users");
  return { success: true };
}

/**
 * Read a role's typed limits (admin-gated wrapper for the editor's initial
 * load). Pure-read `getRoleLimits` lives in `role-limits.ts`.
 */
export async function getRoleLimitsAction(roleId: string): Promise<RoleLimits | null> {
  await requireAdmin();
  return getRoleLimits(roleId);
}
