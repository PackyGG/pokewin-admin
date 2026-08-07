import { isOwnerById, isMainOwnerUsername } from "@/lib/owners";

/**
 * Visibility of excluded (blacklisted) users in the /users search box is now
 * OWNER-gated (was a hard-coded `["motha", "kotha"]` username allowlist before
 * the owner tier; kotha loses access until made an owner — intended). Browsing
 * the unfiltered list still hides excluded users — only an active search by an
 * owner bypasses the exclusion filter.
 *
 * The real boundary is `canCurrentAdminIncludeExcludedInSearch` (resolves the
 * `is_owner` column + the permanent `motha` bypass via `isOwnerById`). The pure
 * `canIncludeExcludedUsersInSearch(username)` can only confirm the permanent
 * MAIN owner from a bare username (owner status otherwise needs the DB row), so
 * it is kept for callers that hold only a username and want the motha bypass;
 * row-aware callers (see users/_lib/admin-gates.ts) compute owner from the row
 * via {@link isExcludedSearchOwnerRow}.
 */
export function canIncludeExcludedUsersInSearch(username: string): boolean {
  return isMainOwnerUsername(username);
}

/** Non-throwing OWNER check for the current admin session user id. */
export async function canCurrentAdminIncludeExcludedInSearch(
  adminUserId: string,
): Promise<boolean> {
  return isOwnerById(adminUserId);
}

/**
 * Owner check from an already-fetched admin row (the consolidated /users
 * page-gate read fetches the row ONCE). Pass the row's `username` + `is_owner`;
 * returns true for the permanent main owner or any flagged owner. Callers must
 * AND this with `is_active` themselves.
 */
export function isExcludedSearchOwnerRow(
  username: string | null | undefined,
  isOwner: boolean | null | undefined,
): boolean {
  return isMainOwnerUsername(username) || isOwner === true;
}
