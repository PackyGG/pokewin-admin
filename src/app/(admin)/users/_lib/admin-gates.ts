import { adminDb } from "@/lib/admin-db";
import { isExcludedSearchOwnerRow } from "@/lib/excluded-users/search-gate";
import { logError } from "@/lib/errors/logger";
import type { SessionPayload } from "@/lib/session";

/**
 * Render-cosmetic gate flags for the /users list page, resolved from ONE
 * admin-DB read.
 *
 * The page previously issued three sequential, unguarded adminDb lookups
 * before first paint (an `allowed_pages` read for the Deleted-users
 * button, an owner check for the Export-all button, and the
 * excluded-search check — the last two reading the SAME `admin_users` row
 * twice). Any adminDb hiccup bypassed the page's safeQuery wrappers
 * entirely and crashed the whole view to error.tsx.
 *
 * Both button gates are gone with their buttons (owner, 2026-07-22), so
 * one flag is left — but the consolidated shape stays: it's still a single
 * `findUnique` on the session's admin row wrapped in try/catch, and it's
 * where any future /users render gate belongs. On failure it logs and
 * FAILS CLOSED — safe because the flag is render-cosmetic; the real
 * boundary is the excluded-search override re-verifying server-side.
 */
export type UsersPageGates = {
  /** Let an active search surface excluded (blacklisted) users. */
  includeExcludedInSearch: boolean;
  /**
   * Show the bulk-ban control. ADMIN/OWNER ONLY — stricter than the
   * single-user ban, which is a support capability. Render-cosmetic:
   * `bulkBanFilteredUsers` re-checks this server-side.
   */
  canBulkBan: boolean;
};

export async function getUsersPageGates(
  session: Pick<SessionPayload, "userId" | "role" | "roles" | "isOwner">,
): Promise<UsersPageGates> {
  // Read off the session, which dal.ts already refreshed from the DB — no
  // extra round-trip just to learn the caller is an admin.
  const canBulkBan =
    (session.roles?.includes("admin") ?? session.role === "admin") ||
    Boolean(session.isOwner);
  try {
    const row = await adminDb.admin_users.findUnique({
      where: { id: session.userId },
      select: { username: true, is_active: true, is_owner: true },
    });
    const active = Boolean(row?.is_active);
    return {
      includeExcludedInSearch:
        active && isExcludedSearchOwnerRow(row?.username ?? "", row?.is_owner ?? false),
      canBulkBan,
    };
  } catch (err) {
    logError(
      "users.gates",
      "admin gate read failed — failing closed on render flags",
      err,
    );
    return {
      includeExcludedInSearch: false,
      // Fails closed like the flag above.
      canBulkBan: false,
    };
  }
}
