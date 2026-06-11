import { adminDb } from "@/lib/admin-db";
import { hasCapability } from "@/app/(admin)/settings/roles/permissions-utils";
import { isUsersExportAdminUsername } from "@/lib/users-export/motha-gate";
import { canIncludeExcludedUsersInSearch } from "@/lib/excluded-users/search-gate";
import { logError } from "@/lib/errors/logger";
import type { SessionPayload } from "@/lib/session";

/**
 * Render-cosmetic gate flags for the /users list page, resolved from ONE
 * admin-DB read.
 *
 * The page previously issued three sequential, unguarded adminDb lookups
 * before first paint: the `allowed_pages` read (non-admins), the
 * `canExportAllUsers` motha check, and the
 * `canCurrentAdminIncludeExcludedInSearch` check — the last two reading
 * the SAME `admin_users` row twice. Any adminDb hiccup bypassed the
 * page's safeQuery wrappers entirely and crashed the whole view to
 * error.tsx.
 *
 * This helper collapses them into a single `findUnique` on the session's
 * admin row, wrapped in try/catch. On failure it logs and FAILS CLOSED
 * (everything false except `canSeeDeletedUsers` for real admins, which
 * needs no DB read) — safe because every flag here is render-cosmetic:
 * the real boundaries are the server actions themselves
 * (`requireUsersExportAdmin`, the delete capability checks, the
 * excluded-search override), which all re-verify independently.
 */
export type UsersPageGates = {
  /** Show the "Deleted users" hero button (admins always; others need the page key + capability). */
  canSeeDeletedUsers: boolean;
  /** Show the motha-only "Export all" button. */
  canExportAll: boolean;
  /** Let an active search surface excluded (blacklisted) users. */
  includeExcludedInSearch: boolean;
};

export async function getUsersPageGates(
  session: Pick<SessionPayload, "userId" | "role">,
): Promise<UsersPageGates> {
  const isAdmin = session.role === "admin";
  try {
    const row = await adminDb.admin_users.findUnique({
      where: { id: session.userId },
      select: { username: true, is_active: true, allowed_pages: true },
    });
    const active = Boolean(row?.is_active);
    const pages = row?.allowed_pages ?? [];
    const username = row?.username ?? "";
    return {
      // Same rule as before the consolidation: real admins always pass;
      // non-admins need BOTH the /users/deleted page key AND the
      // __can_delete_user capability (mirrors the delete action's gate).
      canSeeDeletedUsers:
        isAdmin ||
        (active &&
          pages.includes("/users/deleted") &&
          hasCapability(pages, "__can_delete_user")),
      canExportAll: active && isUsersExportAdminUsername(username),
      includeExcludedInSearch:
        active && username !== "" && canIncludeExcludedUsersInSearch(username),
    };
  } catch (err) {
    logError(
      "users.gates",
      "admin gate read failed — failing closed on render flags",
      err,
    );
    return {
      canSeeDeletedUsers: isAdmin,
      canExportAll: false,
      includeExcludedInSearch: false,
    };
  }
}
