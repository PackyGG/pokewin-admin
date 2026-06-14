import "server-only";

import { adminDb } from "@/lib/admin-db";
import { requireAdmin } from "@/lib/dal";
import {
  getEffectiveRoles,
  isAdminRole,
  type AdminRole,
} from "@/lib/admin-roles";
import { ROLE_BASELINES } from "@/lib/role-baselines";
import { getRoleLimits } from "@/lib/role-limits";
import type { RoleLimits } from "@/lib/permissions/types";
import { EMPTY_ROLE_LIMITS } from "@/lib/permissions/types";

// ---------------------------------------------------------------------------
// Read-only data layer for the per-role editor (RoleV2 P4).
//
// Assembles everything the editor page (`roles/[id]/page.tsx`) needs for ONE
// `admin_roles` row — built-in (system) OR custom — in a single serializable
// payload. READ-ONLY against the ADMIN DB; the mutating paths stay in the
// existing (locked) action files:
//   • built-in caps   → `updateBuiltInRole`   (built-in-roles-actions.ts)
//   • custom caps      → `updateRole`           (custom-roles-actions.ts)
//   • per-role limits → `setRoleLimits`         (role-limits-actions.ts)
//
// This module deliberately lives OUTSIDE the `custom-roles-actions.ts` hotspot
// and changes none of those action signatures — it only reads.
//
// The capability set returned for a built-in is the EDITABLE source the
// materializer reads — `admin_roles.capabilities` on the system row — NOT the
// code `ROLE_BASELINES` constant (which is only the migration seed). So an
// already-edited built-in shows its current, edited caps.
// ---------------------------------------------------------------------------

/** Everything the per-role editor renders for one role. */
export type RoleEditorData = {
  id: string;
  name: string;
  description: string | null;
  /** `true` for a built-in `admin_roles` system row. */
  isSystem: boolean;
  /** The built-in enum key for a system row, else `null` (custom role). */
  systemKey: AdminRole | null;
  /**
   * `true` only for the `admin` system row — the total-bypass superuser. Its
   * caps are ignored by the gate, so the editor renders it read-only.
   */
  bypass: boolean;
  /** Flat token set (page routes ∪ `__can_*` flags ∪ value tokens). */
  capabilities: string[];
  /** Typed per-role limit slots (all-null until an owner sets a cap). */
  limits: RoleLimits;
  /** Admin users currently assigned this role (custom) or holding it (built-in). */
  holderCount: number;
  /**
   * How many NON-admin users a capability save would re-materialize — computed
   * the SAME way the mutating action will: for a built-in, every non-admin
   * whose effective roles include `systemKey`; for a custom role, every
   * `admin_users` row with `role_id = id`. Drives the save-preview count.
   */
  affectedUserCount: number;
};

/**
 * Load the full editor payload for one role id, or `null` if it doesn't exist.
 * Admin-gated (the editor route is admin-only; every role action re-gates).
 */
export async function getRoleEditorData(
  id: string,
): Promise<RoleEditorData | null> {
  await requireAdmin();

  const row = await adminDb.admin_roles.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      description: true,
      is_system: true,
      system_key: true,
      capabilities: true,
      _count: { select: { admin_users: true } },
    },
  });
  if (!row) return null;

  const systemKey: AdminRole | null =
    row.system_key && isAdminRole(row.system_key) ? row.system_key : null;
  const bypass = systemKey ? (ROLE_BASELINES[systemKey]?.bypass ?? false) : false;

  // Per-role limit columns (typed). Falls back to the all-null set defensively
  // (the row exists, so getRoleLimits returns a value, but keep it total).
  const limits = (await getRoleLimits(id)) ?? {
    balanceAdjustment: { ...EMPTY_ROLE_LIMITS.balanceAdjustment },
    issuance: { ...EMPTY_ROLE_LIMITS.issuance! },
  };

  const affectedUserCount = await countAffectedUsers(
    id,
    systemKey,
    Boolean(row.is_system),
  );

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isSystem: Boolean(row.is_system),
    systemKey,
    bypass,
    capabilities: row.capabilities,
    limits,
    holderCount: row._count.admin_users,
    affectedUserCount,
  };
}

/**
 * Count the users a capability edit on this role would re-materialize, mirroring
 * the action logic exactly:
 *   • built-in (system) row → every non-admin admin_user whose effective roles
 *     include `systemKey` (admins are skipped — they bypass the gate); see
 *     `updateBuiltInRole`.
 *   • custom row            → every admin_user with `role_id = id`; see
 *     `updateRole`.
 * The `admin` built-in returns 0 (it's read-only and never re-materialized).
 */
async function countAffectedUsers(
  id: string,
  systemKey: AdminRole | null,
  isSystem: boolean,
): Promise<number> {
  if (isSystem && systemKey) {
    if (systemKey === "admin") return 0;
    // No SQL operator for "membership in the normalized effective-role set" —
    // read role columns and filter in code (same as the action).
    const candidates = await adminDb.admin_users.findMany({
      select: { role: true, roles: true },
    });
    let count = 0;
    for (const u of candidates) {
      const eff = getEffectiveRoles(u.role, u.roles);
      if (eff.includes("admin")) continue;
      if (eff.includes(systemKey)) count++;
    }
    return count;
  }
  // Custom role: assigned users (role_id link).
  return adminDb.admin_users.count({ where: { role_id: id } });
}
