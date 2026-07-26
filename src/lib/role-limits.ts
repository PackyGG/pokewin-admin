// =============================================================================
// role-limits.ts — per-ROLE balance/issuance limit DEFAULTS (RoleV2 P3).
//
// The foundation (P0+P1) added six nullable Decimal(12,2) columns to
// `admin_roles` — `balance_limit_{daily,weekly,monthly}` and
// `issuance_limit_{daily,weekly,monthly}` — keyed per role (built-in rows by
// `system_key`, custom rows by `id`). They are ALL NULL today, so this module
// is provably inert until an owner sets a role's cap.
//
// This module resolves a given admin's effective ROLE balance-limit defaults:
// the most-restrictive (smallest) non-null cap per period across every role the
// admin holds (their built-in `getEffectiveRoles` set PLUS any custom role via
// `role_id`). `admin` carries no spending-cap concept — it is included
// harmlessly (its columns are NULL anyway) and contributes nothing.
//
// These defaults are the LOWER layer of the spend-time cap resolution; the
// per-user `admin_balance_limits` row WINS over the role default. The merge
// (`per-user-row → else role default → else unlimited`) is applied in
// `checkBalanceAdjustmentLimit` (src/lib/balance-limits.ts).
//
// Reads only the ADMIN DB. No game-DB access. No re-materialization
// of `allowed_pages` — limits are enforced live at spend time, not baked into
// the page list. The mutating server action lives in `role-limits-actions.ts`
// (a `"use server"` module), matching the existing balance-limits split
// (balance-limits.ts logic ↔ admin-users/limits-actions.ts action).
// =============================================================================

import { eq, inArray, or } from "drizzle-orm";
import { adminDrizzle } from "@/lib/admin-db";
import { admin_roles, admin_users } from "@/lib/db-schema/admin/schema";
import { getEffectiveRoles } from "@/lib/admin-roles";
import type { RoleLimits } from "@/lib/permissions/types";
import {
  mergeRoleBalanceLimits,
  EMPTY_ROLE_BALANCE_LIMIT_DEFAULTS,
  type RoleBalanceLimitDefaults,
  type RoleBalanceLimitRow,
} from "@/lib/role-limits-merge";

// Re-export the pure merge surface so existing importers can keep using
// `@/lib/role-limits` for both the DB resolvers and the pure helpers. The
// pure math itself lives in `role-limits-merge.ts` (dependency-free → loads in
// the no-DB unit test).
export {
  mergeRoleBalanceLimits,
  resolveEffectiveCap,
  EMPTY_ROLE_BALANCE_LIMIT_DEFAULTS,
} from "@/lib/role-limits-merge";
export type {
  RoleBalanceLimitDefaults,
  RoleBalanceLimitRow,
} from "@/lib/role-limits-merge";

/**
 * Resolve an admin user's effective ROLE balance-limit defaults.
 *
 * Reads the admin's `role` + `roles` (→ effective built-in role set via
 * `getEffectiveRoles`) and `role_id` (the optional custom role), fetches the
 * matching `admin_roles` rows, and returns the most-restrictive non-null
 * `balance_limit_{period}` per period across them. With every column NULL
 * today this always returns `{ daily: null, weekly: null, monthly: null }`,
 * making it inert.
 *
 * Returns `EMPTY_ROLE_BALANCE_LIMIT_DEFAULTS` for an unknown / missing admin.
 */
export async function getRoleBalanceLimitDefaults(
  adminUserId: string,
): Promise<RoleBalanceLimitDefaults> {
  const [user] = await adminDrizzle.select({
    role: admin_users.role, roles: admin_users.roles, role_id: admin_users.role_id,
  }).from(admin_users).where(eq(admin_users.id, adminUserId)).limit(1);
  if (!user) return { ...EMPTY_ROLE_BALANCE_LIMIT_DEFAULTS };

  const effective = getEffectiveRoles(user.role, user.roles);

  // Fetch every role row that applies to this admin: the built-in rows whose
  // `system_key` is one of the effective roles, PLUS the custom role row keyed
  // by `role_id` (if any). One query, OR'd. (Empty `effective` + null
  // `role_id` ⇒ no rows ⇒ all-null defaults.)
  const conditions = [];
  if (effective.length > 0) conditions.push(inArray(admin_roles.system_key, effective));
  if (user.role_id) conditions.push(eq(admin_roles.id, user.role_id));
  if (conditions.length === 0) return { ...EMPTY_ROLE_BALANCE_LIMIT_DEFAULTS };

  const roleRows = await adminDrizzle.select({
      balance_limit_daily: admin_roles.balance_limit_daily,
      balance_limit_weekly: admin_roles.balance_limit_weekly,
      balance_limit_monthly: admin_roles.balance_limit_monthly,
    }).from(admin_roles).where(or(...conditions));

  const rows: RoleBalanceLimitRow[] = roleRows.map((r) => ({
    daily: r.balance_limit_daily === null ? null : Number(r.balance_limit_daily),
    weekly: r.balance_limit_weekly === null ? null : Number(r.balance_limit_weekly),
    monthly: r.balance_limit_monthly === null ? null : Number(r.balance_limit_monthly),
  }));

  return mergeRoleBalanceLimits(rows);
}

/**
 * Read one role's six limit columns → the typed {@link RoleLimits} shape
 * (P4's editor reads this). Returns `null` when the role id doesn't exist.
 * Pure read — admin-only callers should gate (the `setRoleLimits` server
 * action in `role-limits-actions.ts` reads/writes under `requireAdmin`).
 */
export async function getRoleLimits(roleId: string): Promise<RoleLimits | null> {
  const [row] = await adminDrizzle.select({
      balance_limit_daily: admin_roles.balance_limit_daily,
      balance_limit_weekly: admin_roles.balance_limit_weekly,
      balance_limit_monthly: admin_roles.balance_limit_monthly,
      issuance_limit_daily: admin_roles.issuance_limit_daily,
      issuance_limit_weekly: admin_roles.issuance_limit_weekly,
      issuance_limit_monthly: admin_roles.issuance_limit_monthly,
    }).from(admin_roles).where(eq(admin_roles.id, roleId)).limit(1);
  if (!row) return null;

  const num = (v: { toString(): string } | null): number | null =>
    v === null ? null : Number(v);

  return {
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
}
