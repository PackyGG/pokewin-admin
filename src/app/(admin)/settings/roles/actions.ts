"use server";

import { revalidatePath } from "next/cache";
import { adminDb } from "@/lib/admin-db";
import { requireAdmin } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { setLimit, deleteLimit } from "@/lib/balance-limits";
import { ALL_PAGE_KEYS } from "@/lib/admin-pages";

const CONFIGURABLE_ROLES = ["support", "marketing", "creator"] as const;
type ConfigurableRole = (typeof CONFIGURABLE_ROLES)[number];

// Special keys stored inside allowed_pages that aren't actual page routes.
// This avoids DB migrations — the allowed_pages column is a String[] that
// already exists and is the single source of truth for per-user capabilities.
const BALANCE_ADJUST_KEY = "__can_adjust_balance";

/** Parse the daily balance limit from allowed_pages, e.g. "__balance_limit_daily:500" → 500 */
function parseBalanceLimit(pages: string[]): number | null {
  for (const p of pages) {
    if (p.startsWith("__balance_limit_daily:")) {
      const val = Number(p.split(":")[1]);
      return Number.isFinite(val) && val > 0 ? val : null;
    }
  }
  return null;
}

function isConfigurableRole(role: string): role is ConfigurableRole {
  return (CONFIGURABLE_ROLES as readonly string[]).includes(role);
}

export type RoleConfig = {
  pages: string[];
  canAdjustBalance: boolean;
  balanceLimitDaily: number | null;
};

/**
 * Read the current effective permissions for each non-admin role.
 * Derived from the first user of that role (they're batch-synced).
 */
export async function getRolePermissions(): Promise<
  Record<ConfigurableRole, RoleConfig>
> {
  await requireAdmin();

  const users = await adminDb.admin_users.findMany({
    where: { role: { in: [...CONFIGURABLE_ROLES] } },
    select: { role: true, allowed_pages: true },
  });

  const result: Record<ConfigurableRole, RoleConfig> = {
    support: { pages: [], canAdjustBalance: false, balanceLimitDaily: null },
    marketing: { pages: [], canAdjustBalance: false, balanceLimitDaily: null },
    creator: { pages: [], canAdjustBalance: false, balanceLimitDaily: null },
  };

  // Use the first user of each role as the canonical preset
  for (const u of users) {
    if (!isConfigurableRole(u.role)) continue;
    if (result[u.role].pages.length > 0) continue; // already found one
    const allEntries = u.allowed_pages;
    result[u.role] = {
      pages: allEntries.filter((p) => !p.startsWith("__")),
      canAdjustBalance: allEntries.includes(BALANCE_ADJUST_KEY),
      balanceLimitDaily: parseBalanceLimit(allEntries),
    };
  }

  return result;
}

/** Check if a given admin user has the balance adjust capability. */
export function canUserAdjustBalance(allowedPages: string[]): boolean {
  return allowedPages.includes(BALANCE_ADJUST_KEY);
}

/**
 * Update the allowed_pages for ALL admin_users of a given role.
 * Also syncs admin_balance_limits for each user.
 */
export async function updateRolePermissions(
  role: string,
  config: {
    pages: string[];
    canAdjustBalance: boolean;
    balanceLimitDaily: number | null;
  },
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requireAdmin();

  if (!isConfigurableRole(role)) {
    return { success: false, error: "Cannot configure permissions for admin role" };
  }

  const validPages = config.pages.filter((p) => ALL_PAGE_KEYS.includes(p));

  // Build the full allowed_pages array including special capability keys
  const fullPages = [...validPages];
  if (config.canAdjustBalance) {
    fullPages.push(BALANCE_ADJUST_KEY);
  }
  if (config.canAdjustBalance && config.balanceLimitDaily != null && config.balanceLimitDaily > 0) {
    fullPages.push(`__balance_limit_daily:${config.balanceLimitDaily}`);
  }

  // Get all users of this role to sync limits
  const roleUsers = await adminDb.admin_users.findMany({
    where: { role },
    select: { id: true },
  });

  // Batch update allowed_pages
  await adminDb.admin_users.updateMany({
    where: { role },
    data: { allowed_pages: fullPages },
  });

  // Sync admin_balance_limits for each user
  for (const user of roleUsers) {
    if (config.canAdjustBalance && config.balanceLimitDaily != null && config.balanceLimitDaily > 0) {
      await setLimit({
        adminUserId: user.id,
        periodType: "daily",
        maxAmount: config.balanceLimitDaily,
        setBy: session.userId,
      });
    } else {
      // Remove daily limit if balance adjust is off or no limit set
      try {
        await deleteLimit(user.id, "daily", session.userId);
      } catch {
        // Ignore if no limit exists to delete
      }
    }
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "role_permissions_updated",
    metadata: {
      role,
      pages: validPages,
      canAdjustBalance: config.canAdjustBalance,
      balanceLimitDaily: config.balanceLimitDaily,
      users_affected: roleUsers.length,
    },
  });

  revalidatePath("/settings/roles");
  revalidatePath("/", "layout");
  return { success: true };
}
