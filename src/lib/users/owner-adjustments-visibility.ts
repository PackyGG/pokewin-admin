import "server-only";

import { cache } from "react";
import { adminDb } from "@/lib/admin-db";

/**
 * Owner-only visibility gate for ADMIN BALANCE ADJUSTMENTS on the user
 * detail page (security-sensitive).
 *
 * Rule (owner request): NO admin except the trusted owner usernames below
 * may see ANY kind of admin balance adjustment, anywhere on a user. The gate
 * is enforced SERVER-SIDE — the `admin_balance_adjustment` ledger rows are
 * never sent to the client for a non-owner viewer (see
 * `getUserTransactions`). The UI also hides the dedicated adjustments block
 * + the adjustment filter option for non-owners, but that is defence-in-depth
 * only; the data carve-out is the real boundary.
 *
 * Match is case-insensitive against `admin_users.username`. Deliberately
 * narrower than the salary founder allowlist — only explicitly listed admins
 * may see adjustments.
 */

/** Admin usernames allowed to see admin balance adjustments on user detail. */
export const ADJUSTMENT_VISIBILITY_OWNER_USERNAMES = [
  "motha",
  "picasso",
  "picassopixel",
] as const;

export function isAdjustmentVisibilityOwnerUsername(username: string): boolean {
  const lower = username.trim().toLowerCase();
  return ADJUSTMENT_VISIBILITY_OWNER_USERNAMES.some((u) => u === lower);
}

/**
 * True iff the given ADMIN user (by their `admin_users.id`) is on the
 * adjustment-visibility allowlist and is currently active. Reads the ADMIN
 * DB (read-only) and is `cache()`d so repeated calls within one request are
 * free.
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
          user.username &&
          isAdjustmentVisibilityOwnerUsername(user.username),
      );
    } catch {
      return false;
    }
  },
);
