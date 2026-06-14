/**
 * Phase A — the pure materializer for the role/permission rebuild.
 *
 * `computeEffectivePermissions(input)` turns the NEW editable source (locked
 * role baselines + custom-role tokens + per-user grants/revokes) into the
 * exact flat permission-token set the runtime gate consumes today. It is the
 * single function shared by the (future) write paths AND the read-only parity
 * harness that proves byte-equality with every user's current `allowed_pages`.
 *
 * Behavior-neutral by design: Phase A does not wire this into any write path
 * and does not touch `allowed_pages`. The gate still reads `allowed_pages`
 * unchanged (see `getUserPermissions` in `src/lib/dal.ts`).
 *
 * PURE — no `server-only`, no DB, no Next server graph — so it is importable
 * by a plain `node:test` parity fixture. See `ROLE_REDESIGN_DESIGN.md`
 * (§"New code (Phase A)") for the canonical algorithm.
 */

import { getEffectiveRoles } from "@/lib/admin-roles";
import { baselineTokensFor } from "@/lib/role-baselines";
import { sanitizePermissionKeys } from "@/app/(admin)/settings/roles/permissions-utils";
import type {
  PermissionToken,
  UserPermissionInput,
} from "@/lib/permissions/types";

/**
 * The three-layer effective permission set for one admin user:
 *
 *   effective = sanitize(
 *       ⋃ over r in roles(user) of BASELINE[r]   // locked built-ins
 *     ∪ user.customRoleTokens                    // custom-role capabilities
 *     ∪ user.override.grants                     // explicit additive grants
 *     \ user.override.revokes )                  // revokes win
 *
 * - `admin` anywhere in the effective role set → returns `[]` (total bypass),
 *   identical to the `admin`-among-roles branch in `dal.ts`'s
 *   `getUserPermissions`. The gate treats `[]` from an admin as full access.
 * - Order matters: grants are added, then revokes are removed last, so a
 *   revoke beats a baseline or grant for the same token.
 * - `sanitizePermissionKeys` is value-token-aware (see permissions-utils.ts),
 *   so it preserves recognized value tokens like `__balance_limit_daily:10`
 *   while still dropping genuinely-unknown entries and de-duplicating.
 *
 * Pure: deterministic for a given input, no I/O, no globals.
 */
export function computeEffectivePermissions(
  input: UserPermissionInput,
): PermissionToken[] {
  const roles = getEffectiveRoles(input.role, input.roles);

  // Total-bypass sentinel — matches getUserPermissions returning [] for any
  // admin (the gate then bypasses every page/capability check). Stays FIRST
  // and unaffected by `baselines`: admin's access is the gate bypass, never a
  // token list, so an edited admin baseline can't widen OR narrow it here.
  if (roles.includes("admin")) return [];

  const set = new Set<PermissionToken>();
  for (const role of roles) {
    // RoleV2 P1: `input.baselines` (the DB-backed map) overrides the code
    // baseline per-role when present; otherwise falls back to ROLE_BASELINES.
    // Behavior-neutral at migration (seeded map === code).
    for (const token of baselineTokensFor(role, input.baselines)) set.add(token);
  }
  for (const token of input.customRoleTokens) set.add(token);
  for (const token of input.override.grants) set.add(token);
  for (const token of input.override.revokes) set.delete(token);

  return sanitizePermissionKeys([...set]);
}
