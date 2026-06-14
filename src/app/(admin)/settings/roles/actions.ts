"use server";

import { requireAdmin } from "@/lib/dal";
import { ALL_ADMIN_ROLES, isAdminRole } from "@/lib/admin-roles";

// ---------------------------------------------------------------------------
// Built-in role permissions are LOCKED (Phase B of the role/permission
// rebuild — see ROLE_REDESIGN_DESIGN.md).
//
// The owner forbids changing what a built-in (enum) role grants. The
// canonical baseline for each built-in role is code-defined in
// `src/lib/role-baselines.ts` (`ROLE_BASELINES`) and rendered read-only in
// the /settings/roles inspector. There is no longer an editor that overwrites
// the `allowed_pages` of every user of a role.
//
// This module previously held:
//   • getRolePermissions()    — seeded the built-in editor from the richest
//                               live `allowed_pages` per role, and
//   • updateRolePermissions() — a blunt `updateMany` that OVERWROTE every
//                               user-of-the-role's `allowed_pages`.
// Both are gone. `updateRolePermissions` is retained ONLY as a hard server-
// side lock: it now REJECTS every built-in role so a baseline can never be
// edited again, and performs NO write under any input. Removing the
// `updateMany` changes NO user's current `allowed_pages` — it only prevents
// future edits to built-in baselines.
//
// Per-admin balance limits (`admin_balance_limits`) and per-user page grants
// remain managed on /admin-users/[id]; this file never touched those.
// Custom roles stay fully editable via `custom-roles-actions.ts`.
// ---------------------------------------------------------------------------

/**
 * Built-in role baselines are immutable. This action exists purely to make
 * that constraint enforceable server-side: any attempt to edit a built-in
 * role's permissions is rejected with a clear error and performs NO write.
 *
 * Built-in roles are the 6 enum roles in `ALL_ADMIN_ROLES`
 * (admin / support / marketing / creator / pack_creator / creator_manager).
 * Custom roles are NOT handled here — they remain fully editable via
 * `custom-roles-actions.ts` (`updateRole`, keyed by the `admin_roles` UUID).
 *
 * Kept as an async function (a "use server" module may only export async
 * functions) with the role argument so the lock is a drop-in for any residual
 * caller. There is no code path under which a built-in baseline is written.
 */
export async function updateRolePermissions(
  role: string,
): Promise<{ success: false; error: string }> {
  // Gate to admins — reading/attempting this is an admin-only surface.
  await requireAdmin();

  if (isAdminRole(role)) {
    return {
      success: false,
      error:
        "Built-in role baselines are locked and can't be edited. Create a custom role for adjustable presets, or set per-user access on the user's profile.",
    };
  }

  // Built-in editing is the only thing this action ever did; custom roles are
  // edited through custom-roles-actions.ts. Reject anything else too — nothing
  // here is writable.
  return {
    success: false,
    error: `Unknown built-in role "${role}". Built-in roles are ${ALL_ADMIN_ROLES.join(", ")}; custom roles are edited from their own page.`,
  };
}
