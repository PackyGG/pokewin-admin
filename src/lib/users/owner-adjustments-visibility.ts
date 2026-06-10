import "server-only";

import { cache } from "react";
import { adminDb } from "@/lib/admin-db";

/**
 * Owner-only visibility gate for ADMIN BALANCE ADJUSTMENTS on the user
 * detail page (security-sensitive).
 *
 * Rule (owner request): NO admin except the owner `motha` may see ANY kind
 * of admin balance adjustment, anywhere on a user. The gate is enforced
 * SERVER-SIDE — the `admin_balance_adjustment` ledger rows are never sent to
 * the client for a non-owner viewer (see `getUserTransactions`). The UI also
 * hides the dedicated adjustments block + the adjustment filter option for
 * non-owners, but that is defence-in-depth only; the data carve-out is the
 * real boundary.
 *
 * "Owner" is identified by the admin's `username` being exactly `motha`
 * (case-insensitive), matching the existing founder-identity convention used
 * by the Creator-Hub gate (`CREATOR_HUB_OWNER_USERNAME` in
 * `creator-hub-access.ts`). This is deliberately NARROWER than the salary
 * founder allowlist (`["motha","void","kotha"]` in `salary/motha-gate.ts`):
 * here only `motha` may see adjustments, so we match on the single owner
 * username rather than reusing that wider list.
 */

/** Lowercased owner username with the adjustment-visibility bypass. */
const OWNER_USERNAME = "motha";

/**
 * True iff the given ADMIN user (by their `admin_users.id`) is the owner
 * `motha` and is currently active. Reads the ADMIN DB (read-only) and is
 * `cache()`d so repeated calls within one request are free.
 *
 * Returns `false` (fail-closed) for an unknown id, an inactive user, a
 * username mismatch, or a transient admin-DB read failure — so a hiccup can
 * only ever HIDE adjustments from a non-owner, never reveal them.
 */
export const isAdjustmentVisibilityOwner = cache(
  async (adminUserId: string): Promise<boolean> => {
    try {
      const user = await adminDb.admin_users.findUnique({
        where: { id: adminUserId },
        select: { username: true, is_active: true },
      });
      return Boolean(
        user?.is_active &&
          (user.username ?? "").toLowerCase() === OWNER_USERNAME,
      );
    } catch {
      return false;
    }
  },
);
