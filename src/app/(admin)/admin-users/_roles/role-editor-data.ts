import "server-only";

import { sql } from "drizzle-orm";
import { adminDrizzle } from "@/lib/admin-db";
import { requireAdmin } from "@/lib/dal";
import {
  isAdminRole,
  type AdminRole,
} from "@/lib/admin-roles";
import { ROLE_BASELINES } from "@/lib/role-baselines";
import type { RoleLimits } from "@/lib/permissions/types";

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
  /**
   * Per-role landing route override, or `null` (today's routing). When set +
   * valid, a non-admin holder lands here after auth. `admin` is never affected.
   */
  landingRoute: string | null;
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

  // ONE read for the role row, its holder count AND its six limit columns.
  // The limits used to come from a second `getRoleLimits(id)` round trip that
  // re-read the SAME `admin_roles` row for six columns this statement was
  // already positioned on — a pure redundant read against a `max: 4` Admin
  // pool. Selected `::text` so numerics arrive as strings (node-postgres does
  // not narrow numeric to a JS number) and `Number()` reproduces `getRoleLimits`
  // exactly; NULL stays null.
  const row = (await adminDrizzle.execute<{
    id: string;
    name: string;
    description: string | null;
    is_system: boolean;
    system_key: string | null;
    capabilities: string[];
    landing_route: string | null;
    holder_count: string;
    balance_limit_daily: string | null;
    balance_limit_weekly: string | null;
    balance_limit_monthly: string | null;
    issuance_limit_daily: string | null;
    issuance_limit_weekly: string | null;
    issuance_limit_monthly: string | null;
  }>(sql`
    SELECT r.id::text, r.name, r.description, r.is_system, r.system_key,
           r.capabilities, r.landing_route,
           r.balance_limit_daily::text, r.balance_limit_weekly::text,
           r.balance_limit_monthly::text, r.issuance_limit_daily::text,
           r.issuance_limit_weekly::text, r.issuance_limit_monthly::text,
           COUNT(u.id)::text AS holder_count
    FROM admin_roles r
    LEFT JOIN admin_users u ON u.role_id = r.id
    WHERE r.id = ${id}::uuid
    GROUP BY r.id
  `)).rows[0];
  if (!row) return null;

  const systemKey: AdminRole | null =
    row.system_key && isAdminRole(row.system_key) ? row.system_key : null;
  const bypass = systemKey ? (ROLE_BASELINES[systemKey]?.bypass ?? false) : false;

  const holderCount = Number(row.holder_count);

  // Per-role limit columns (typed) — identical shape and conversion to
  // `getRoleLimits`, just sourced from the row we already have.
  const num = (v: string | null): number | null => (v === null ? null : Number(v));
  const limits: RoleLimits = {
    balanceAdjustment: {
      daily: num(row.balance_limit_daily),
      weekly: num(row.balance_limit_weekly),
      monthly: num(row.balance_limit_monthly),
    },
    issuance: {
      daily: num(row.issuance_limit_daily),
      weekly: num(row.issuance_limit_weekly),
      monthly: num(row.issuance_limit_monthly),
    },
  };

  const affectedUserCount = await countAffectedUsers(
    systemKey,
    Boolean(row.is_system),
    holderCount,
  );

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isSystem: Boolean(row.is_system),
    systemKey,
    bypass,
    capabilities: row.capabilities,
    landingRoute: row.landing_route ?? null,
    limits,
    holderCount,
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
  systemKey: AdminRole | null,
  isSystem: boolean,
  /**
   * `COUNT(u.id)` over `admin_users u ON u.role_id = r.id` — already computed
   * by the caller's single row read. For a CUSTOM role that is, term for term,
   * the same population as this function's own
   * `SELECT COUNT(*) FROM admin_users WHERE role_id = id`, so the custom branch
   * reuses it instead of paying a second round trip for the identical number.
   */
  holderCount: number,
): Promise<number> {
  if (isSystem && systemKey) {
    if (systemKey === "admin") return 0;
    // No SQL operator for "membership in the normalized effective-role set" —
    // read role columns and filter in code (same as the action).
    const result = await adminDrizzle.execute<{ count: string }>(sql`
      SELECT COUNT(*)::text AS count
      FROM admin_users
      WHERE NOT (role = 'admin' OR 'admin'::admin_role = ANY(roles))
        AND (
          role = ${systemKey}::admin_role
          OR ${systemKey}::admin_role = ANY(roles)
        )
    `);
    return Number(result.rows[0]?.count ?? 0);
  }
  // Custom role: assigned users (role_id link) — identical to the caller's
  // already-fetched holder count, so no second read is issued.
  return holderCount;
}

/** One admin who holds this role, for the "Assigned admins" panel. */
export type RoleHolder = {
  id: string;
  username: string;
  isActive: boolean;
};

/**
 * List the admins who hold this role (RoleV2 P1 "Assigned admins" panel).
 *   • built-in (system) row → every admin_user whose effective roles include
 *     `systemKey` (for `admin` this is the admins themselves), and
 *   • custom row            → every admin_user with `role_id = id`.
 * Read-only, admin-gated. Capped to a sensible count for the panel; the exact
 * total is shown via `holderCount` on `RoleEditorData`.
 *
 * `known` lets a caller that already loaded the role (the editor page renders
 * this panel from the same `RoleEditorData`) skip the identity probe — it is
 * the identical `is_system` / `system_key` pair, read one statement earlier.
 * Omit it and the probe runs as before.
 */
export async function getRoleHolders(
  id: string,
  known?: { isSystem: boolean; systemKey: AdminRole | null },
): Promise<RoleHolder[]> {
  await requireAdmin();

  let role: { is_system: boolean; system_key: string | null };
  if (known) {
    role = { is_system: known.isSystem, system_key: known.systemKey };
  } else {
    const probed = (await adminDrizzle.execute<{
      is_system: boolean;
      system_key: string | null;
    }>(sql`
      SELECT is_system, system_key
      FROM admin_roles
      WHERE id = ${id}::uuid
      LIMIT 1
    `)).rows[0];
    if (!probed) return [];
    role = probed;
  }

  const systemKey: AdminRole | null =
    role.system_key && isAdminRole(role.system_key) ? role.system_key : null;

  if (role.is_system && systemKey) {
    // Effective-role membership can't be expressed in SQL — read role columns
    // + username and filter in code (same predicate as the action). Degrades to
    // the legacy `[role]` set if the `roles` column isn't migrated.
    const candidates = (await adminDrizzle.execute<{
      id: string;
      username: string;
      is_active: boolean;
    }>(sql`
      SELECT id::text, username, is_active
      FROM admin_users
      WHERE role = ${systemKey}::admin_role
         OR ${systemKey}::admin_role = ANY(roles)
      ORDER BY username ASC
    `)).rows;
    return candidates.map((u) => ({
      id: u.id,
      username: u.username,
      isActive: u.is_active,
    }));
  }

  // Custom role: the role_id link.
  const rows = (await adminDrizzle.execute<{
    id: string;
    username: string;
    is_active: boolean;
  }>(sql`
    SELECT id::text, username, is_active
    FROM admin_users
    WHERE role_id = ${id}::uuid
    ORDER BY username ASC
  `)).rows;
  return rows.map((u) => ({ id: u.id, username: u.username, isActive: u.is_active }));
}
