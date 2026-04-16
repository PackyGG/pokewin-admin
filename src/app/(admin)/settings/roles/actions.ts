"use server";

import { revalidatePath } from "next/cache";
import { adminDb } from "@/lib/admin-db";
import { requireAdmin } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { setLimit, deleteLimit } from "@/lib/balance-limits";
import { ALL_PAGE_KEYS } from "@/lib/admin-pages";
import {
  type CapabilityState,
  buildCapabilityKeys,
  extractCapabilityStates,
  parseBalanceLimit,
} from "./permissions-utils";

const CONFIGURABLE_ROLES = ["support", "marketing", "creator"] as const;
type ConfigurableRole = (typeof CONFIGURABLE_ROLES)[number];

function isConfigurableRole(role: string): role is ConfigurableRole {
  return (CONFIGURABLE_ROLES as readonly string[]).includes(role);
}

export type RoleConfig = {
  pages: string[];
  capabilities: Record<string, CapabilityState>;
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

  const emptyConfig = (): RoleConfig => ({
    pages: [],
    capabilities: extractCapabilityStates([]),
  });

  const result: Record<ConfigurableRole, RoleConfig> = {
    support: emptyConfig(),
    marketing: emptyConfig(),
    creator: emptyConfig(),
  };

  // Use the first user of each role as the canonical preset
  const found = new Set<string>();
  for (const u of users) {
    if (!isConfigurableRole(u.role)) continue;
    if (found.has(u.role)) continue;
    found.add(u.role);
    result[u.role] = {
      pages: u.allowed_pages.filter((p) => !p.startsWith("__")),
      capabilities: extractCapabilityStates(u.allowed_pages),
    };
  }

  return result;
}

/**
 * Update the allowed_pages for ALL admin_users of a given role.
 * Also syncs admin_balance_limits for each user.
 */
export async function updateRolePermissions(
  role: string,
  config: {
    pages: string[];
    capabilities: Record<string, CapabilityState>;
  },
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requireAdmin();

  if (!isConfigurableRole(role)) {
    return { success: false, error: "Cannot configure permissions for admin role" };
  }

  const validPages = config.pages.filter((p) => ALL_PAGE_KEYS.includes(p));
  const capabilityKeys = buildCapabilityKeys(config.capabilities);
  const fullPages = [...validPages, ...capabilityKeys];

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

  // Sync admin_balance_limits for each user based on the balance adjust capability
  const balanceState = config.capabilities["__can_adjust_balance"];
  const balanceLimit = balanceState?.enabled
    ? parseBalanceLimit(capabilityKeys)
    : null;

  for (const user of roleUsers) {
    if (balanceLimit) {
      await setLimit({
        adminUserId: user.id,
        periodType: balanceLimit.period,
        maxAmount: balanceLimit.amount,
        setBy: session.userId,
      });
    } else {
      // Remove limits if balance adjust is off or no limit set
      for (const period of ["daily", "weekly"] as const) {
        try { await deleteLimit(user.id, period, session.userId); } catch { /* no limit to delete */ }
      }
    }
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "role_permissions_updated",
    metadata: {
      role,
      pages: validPages,
      capabilities: config.capabilities,
      users_affected: roleUsers.length,
    },
  });

  revalidatePath("/settings/roles");
  revalidatePath("/", "layout");
  return { success: true };
}
