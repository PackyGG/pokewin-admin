"use server";

import { revalidatePath } from "next/cache";
import { adminDb } from "@/lib/admin-db";
import { requireAdmin } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { ALL_PAGE_KEYS } from "@/lib/admin-pages";
import {
  type CapabilityState,
  buildCapabilityKeys,
  extractCapabilityStates,
} from "./permissions-utils";

// NOTE: Balance adjustment limits are deliberately NOT touched here.
// Per-admin balance limits live in `admin_balance_limits` and are
// configured per user on /admin-users/[id]. The role editor only
// controls page access + capability flags. Earlier versions of this
// action auto-cascaded a role-level balance limit to every user of
// that role, which silently overwrote individually-set per-admin
// limits. That cascade has been removed; admins manage balance
// limits exclusively from the per-user "Adjust Balance Limit" card.

const CONFIGURABLE_ROLES = [
  "support",
  "marketing",
  "creator",
  "pack_creator",
] as const;
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
    pack_creator: emptyConfig(),
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
 *
 * Only affects page access + capability flags stored in `allowed_pages`.
 * Per-admin balance limits in `admin_balance_limits` are intentionally
 * NOT touched — those are managed individually on /admin-users/[id].
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

  // Count for audit context only — no per-user fan-out happens here anymore.
  const usersAffected = await adminDb.admin_users.count({ where: { role } });

  await adminDb.admin_users.updateMany({
    where: { role },
    data: { allowed_pages: fullPages },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "role_permissions_updated",
    metadata: {
      role,
      pages: validPages,
      capabilities: config.capabilities,
      users_affected: usersAffected,
    },
  });

  revalidatePath("/settings/roles");
  revalidatePath("/", "layout");
  return { success: true };
}
