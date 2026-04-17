import { adminDb } from "@/lib/admin-db";
import { hasCapability } from "@/app/(admin)/settings/roles/permissions-utils";

/**
 * Capability gate for admin server actions.
 *
 * Real admins always pass. For any non-admin role, the capability key is
 * looked up on the admin_users row (stored alongside page keys in the
 * allowed_pages String[] column — capability entries are prefixed with
 * `__can_` so they can't collide with page routes).
 *
 * Throws with a user-facing message if the capability is not granted.
 * Intended to be called AFTER the page-access check (requirePageAccess /
 * verifySession) — it narrows within a page that the user already has
 * access to.
 */
export async function requireCapability(
  session: { userId: string; role: string },
  capability: string,
  actionLabel: string,
): Promise<void> {
  if (session.role === "admin") return;

  const perms = await adminDb.admin_users.findUnique({
    where: { id: session.userId },
    select: { allowed_pages: true },
  });

  if (!perms || !hasCapability(perms.allowed_pages, capability)) {
    throw new Error(`You do not have permission to ${actionLabel}`);
  }
}
