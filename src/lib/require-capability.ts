import { adminDb } from "@/lib/admin-db";
import { hasCapability } from "@/app/(admin)/settings/roles/permissions-utils";
import { getEffectiveRoles } from "@/lib/admin-roles";

/**
 * Capability gate for admin server actions.
 *
 * Real admins always pass — "admin" anywhere in the user's effective role
 * set is a full-access bypass. For any non-admin user, the capability key
 * is looked up on the admin_users row (stored alongside page keys in the
 * allowed_pages String[] column — capability entries are prefixed with
 * `__can_` so they can't collide with page routes). With multi-role the
 * baselines of every assigned role are already unioned into allowed_pages,
 * so this single read is the union of the user's roles.
 *
 * Throws with a user-facing message if the capability is not granted.
 * Intended to be called AFTER the page-access check (requirePageAccess /
 * verifySession) — it narrows within a page that the user already has
 * access to.
 */
export async function requireCapability(
  session: { userId: string; role: string; roles?: string[] },
  capability: string,
  actionLabel: string,
): Promise<void> {
  // Effective-role admin bypass. A multi-role user that holds `admin`
  // anywhere passes; the session-derived check avoids a DB hit when the
  // caller already carries the role set.
  if (getEffectiveRoles(session.role, session.roles).includes("admin")) return;

  const perms = await adminDb.admin_users.findUnique({
    where: { id: session.userId },
    select: { role: true, roles: true, allowed_pages: true },
  });

  if (!perms) {
    throw new Error(`You do not have permission to ${actionLabel}`);
  }
  // Defence in depth: re-derive admin from the DB row too (the session
  // shape is caller-supplied — never trust it alone for the bypass).
  if (getEffectiveRoles(perms.role, perms.roles).includes("admin")) return;

  if (!hasCapability(perms.allowed_pages, capability)) {
    throw new Error(`You do not have permission to ${actionLabel}`);
  }
}
