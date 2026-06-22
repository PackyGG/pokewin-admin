import "server-only";

import { cache } from "react";
import { adminDb } from "@/lib/admin-db";
import { readAdminUserWithOverrides } from "@/lib/admin-user-roles";
import { isOwnerById, isMainOwnerUsername } from "@/lib/owners";

/**
 * Visibility of ADMIN BALANCE ADJUSTMENTS on the user detail page is gated:
 *   • OWNERS always see them (DB `is_owner` flag, plus the permanent `motha`
 *     username bypass), AND
 *   • any admin user — owner or not, role-agnostic — who carries the
 *     `__can_view_balance_adjustments` capability in their `allowed_pages`
 *     also sees them.
 *
 * History: this used to be a hard-coded username allowlist (`motha`,
 * `picasso`, `picassopixel`); commit a34c531b tightened it to owner-only when
 * the formal owner tier shipped, which left `picasso` / `picassopixel` (and
 * any future non-owner admin who legitimately needs visibility) without a
 * granular knob short of full owner promotion. The capability above is that
 * knob — grantable via the Settings → Roles editor like any other `__can_*`
 * flag, no owner promotion required. EDITING balance adjustments stays on the
 * separate `canEditBalanceAdjustments` (motha-only) gate. The gate is
 * enforced SERVER-SIDE — the `admin_balance_adjustment` ledger rows are never
 * sent to the client for a viewer who passes neither leg (see
 * `getUserTransactions`).
 */

/** Capability key that grants admin-balance-adjustment view visibility. */
export const VIEW_BALANCE_ADJUSTMENTS_CAPABILITY =
  "__can_view_balance_adjustments";

/**
 * Pure username predicate — confirms only the permanent MAIN owner from a bare
 * username (full owner status otherwise needs the DB `is_owner` flag). Kept for
 * callers that hold only a username.
 */
export function isAdjustmentVisibilityOwnerUsername(
  username: string | null | undefined,
): boolean {
  return isMainOwnerUsername(username);
}

/**
 * True iff the given ADMIN user (by their `admin_users.id`) may VIEW
 * admin_balance_adjustment rows on the user-detail Finances surface. Passes if
 * EITHER the user is an owner (via the central owner resolver — DB `is_owner`
 * or the permanent `motha` username bypass) OR their `allowed_pages` array
 * carries the `__can_view_balance_adjustments` capability flag. `cache()`d so
 * repeated calls within one request are free.
 *
 * Fails CLOSED on any read failure: a hiccup can only ever HIDE adjustments
 * from a viewer, never reveal them.
 *
 * Name preserved for backwards-compat with existing call sites (kept literal
 * so grep across the codebase still works); the helper is no longer strictly
 * owner-only — see the module-header comment.
 */
export const isAdjustmentVisibilityOwner = cache(
  async (adminUserId: string): Promise<boolean> => {
    // Owners always pass (delegates to the central resolver — fails closed).
    if (await isOwnerById(adminUserId)) return true;

    // Capability leg — read the admin row's permission state DIRECTLY (skipping
    // the `getUserPermissions` dal helper, which collapses to `[]` for users
    // with the `admin` role; we need the raw arrays so a real admin can also
    // hold the capability without being promoted to owner).
    //
    // Two columns can carry the token:
    //   • `allowed_pages` — the materialized runtime cache the rest of the
    //     gate machinery reads (`hasCapability` runs against this for
    //     non-admins).
    //   • `permission_grants` — the editable per-user override the role tooling
    //     persists. Re-materializing an admin via the role editor would empty
    //     `allowed_pages` (the admin bypass returns `[]`), so checking
    //     `permission_grants` too keeps the grant durable across that path.
    //
    // Fail-closed on any read error — the row may be inactive, an additive
    // column may be missing on some deploy (degrade via the resilient wrapper),
    // etc. — so a hiccup can only ever HIDE adjustments, never reveal them.
    try {
      const row = await readAdminUserWithOverrides(
        () =>
          adminDb.admin_users.findUnique({
            where: { id: adminUserId },
            select: {
              is_active: true,
              allowed_pages: true,
              permission_grants: true,
            },
          }),
        () =>
          adminDb.admin_users.findUnique({
            where: { id: adminUserId },
            select: { is_active: true, allowed_pages: true },
          }),
      );
      if (!row?.is_active) return false;
      const r = row as {
        allowed_pages: string[];
        permission_grants: string[];
      };
      if ((r.allowed_pages ?? []).includes(VIEW_BALANCE_ADJUSTMENTS_CAPABILITY))
        return true;
      if (
        (r.permission_grants ?? []).includes(VIEW_BALANCE_ADJUSTMENTS_CAPABILITY)
      )
        return true;
      return false;
    } catch {
      return false;
    }
  },
);
