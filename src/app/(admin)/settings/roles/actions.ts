"use server";

import { revalidatePath } from "next/cache";
import { adminDb } from "@/lib/admin-db";
import { requireAdmin } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { ALL_PAGE_KEYS } from "@/lib/admin-pages";

const CONFIGURABLE_ROLES = ["support", "marketing", "creator"] as const;
type ConfigurableRole = (typeof CONFIGURABLE_ROLES)[number];

function isConfigurableRole(role: string): role is ConfigurableRole {
  return (CONFIGURABLE_ROLES as readonly string[]).includes(role);
}

/**
 * Read the current effective permissions for each non-admin role.
 * Derived from the union of allowed_pages across all users of that role.
 * If no users exist for a role, the preset is empty.
 */
export async function getRolePermissions(): Promise<
  Record<ConfigurableRole, string[]>
> {
  await requireAdmin();

  const users = await adminDb.admin_users.findMany({
    where: { role: { in: [...CONFIGURABLE_ROLES] } },
    select: { role: true, allowed_pages: true },
  });

  const result: Record<ConfigurableRole, Set<string>> = {
    support: new Set(),
    marketing: new Set(),
    creator: new Set(),
  };

  for (const u of users) {
    if (!isConfigurableRole(u.role)) continue;
    for (const page of u.allowed_pages) {
      result[u.role].add(page);
    }
  }

  return {
    support: [...result.support],
    marketing: [...result.marketing],
    creator: [...result.creator],
  };
}

/**
 * Update the allowed_pages for ALL admin_users of a given role.
 * This is the "role preset" — it batch-updates every user of that role.
 */
export async function updateRolePermissions(
  role: string,
  pages: string[],
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requireAdmin();

  if (!isConfigurableRole(role)) {
    return { success: false, error: "Cannot configure permissions for admin role" };
  }

  const validPages = pages.filter((p) => ALL_PAGE_KEYS.includes(p));

  const { count } = await adminDb.admin_users.updateMany({
    where: { role },
    data: { allowed_pages: validPages },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "role_permissions_updated",
    metadata: { role, pages: validPages, users_affected: count },
  });

  revalidatePath("/settings/roles");
  revalidatePath("/", "layout");
  return { success: true };
}
