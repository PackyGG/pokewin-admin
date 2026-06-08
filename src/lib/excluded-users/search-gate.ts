import { adminDb } from "@/lib/admin-db";

/**
 * Admin usernames allowed to find excluded (blacklisted) users via the
 * /users search box. Browsing the unfiltered list still hides them —
 * only an active search bypasses the exclusion filter.
 */
const USER_SEARCH_EXCLUDED_VISIBILITY = ["motha", "kotha"] as const;

export function canIncludeExcludedUsersInSearch(username: string): boolean {
  const lower = username.toLowerCase();
  return USER_SEARCH_EXCLUDED_VISIBILITY.some((u) => u === lower);
}

/** Non-throwing check for the current admin session user id. */
export async function canCurrentAdminIncludeExcludedInSearch(
  adminUserId: string,
): Promise<boolean> {
  const user = await adminDb.admin_users.findUnique({
    where: { id: adminUserId },
    select: { username: true, is_active: true },
  });
  return Boolean(
    user?.is_active &&
      user.username &&
      canIncludeExcludedUsersInSearch(user.username),
  );
}
