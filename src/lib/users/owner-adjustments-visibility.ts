import "server-only";

import { cache } from "react";
import { isOwnerById, isMainOwnerUsername } from "@/lib/owners";

/**
 * Visibility of ADMIN BALANCE ADJUSTMENTS on the user detail page is now
 * OWNER-gated (security-sensitive). It used to be a hard-coded username
 * allowlist (`motha`, `picasso`, `picassopixel`); with the owner tier only
 * owners may see admin balance adjustments — `picasso` / `picassopixel` lose
 * visibility until made owners (intended per the owner-tier rollout). The gate
 * is enforced SERVER-SIDE — the `admin_balance_adjustment` ledger rows are
 * never sent to the client for a non-owner viewer (see `getUserTransactions`).
 */

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
 * True iff the given ADMIN user (by their `admin_users.id`) is an owner and
 * active. `cache()`d so repeated calls within one request are free. Delegates
 * to the central owner resolver, which reads `is_owner` + the permanent `motha`
 * bypass and FAILS CLOSED on any read failure — so a hiccup can only ever HIDE
 * adjustments from a non-owner, never reveal them.
 */
export const isAdjustmentVisibilityOwner = cache(
  async (adminUserId: string): Promise<boolean> => {
    return isOwnerById(adminUserId);
  },
);
