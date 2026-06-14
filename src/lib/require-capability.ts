import { adminDb } from "@/lib/admin-db";
import { hasCapability } from "@/app/(admin)/settings/roles/permissions-utils";
import { getEffectiveRoles } from "@/lib/admin-roles";
import { readAdminUserWithRoles } from "@/lib/admin-user-roles";

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
  session: { userId: string; role: string; roles?: string[]; username?: string; isOwner?: boolean },
  capability: string,
  actionLabel: string,
): Promise<void> {
  // Effective-role admin bypass. A multi-role user that holds `admin`
  // anywhere passes; the session-derived check avoids a DB hit when the
  // caller already carries the role set.
  if (getEffectiveRoles(session.role, session.roles).includes("admin")) return;

  // Owner / ultra-admin bypass (orthogonal to the role model — sees every
  // capability, like `admin`). The session-derived check (`isOwner` flag set
  // DB-fresh by verifySession, or the permanent `motha` username) avoids a DB
  // hit on the hot path; a DB-side defence-in-depth re-read follows below for
  // the non-bypass branch in case the caller supplied a thin session object.
  if (
    session.isOwner === true ||
    (session.username ?? "").trim().toLowerCase() === "motha"
  ) {
    return;
  }

  // Resilient to the unapplied `roles` migration: degrades to `roles: []`
  // (→ effective `[role]`) so a gated server action can't crash when the
  // column is absent. Security is unchanged — `[role]` grants no more than
  // the user's single role.
  const perms = await readAdminUserWithRoles(
    () =>
      adminDb.admin_users.findUnique({
        where: { id: session.userId },
        select: { role: true, roles: true, allowed_pages: true },
      }),
    () =>
      adminDb.admin_users.findUnique({
        where: { id: session.userId },
        select: { role: true, allowed_pages: true },
      }),
  );

  if (!perms) {
    throw new Error(`You do not have permission to ${actionLabel}`);
  }
  // Defence in depth: re-derive admin from the DB row too (the session
  // shape is caller-supplied — never trust it alone for the bypass).
  if (getEffectiveRoles(perms.role, perms.roles).includes("admin")) return;

  // Defence in depth for the owner bypass: re-read username + is_owner from the
  // DB so a thin / spoofed caller session can't slip past, mirroring the admin
  // re-derivation above. P2022-safe (the column may be absent on an un-migrated
  // DB) → degrades to non-owner so it can only ever DENY, never grant. The
  // permanent `motha` username owner is re-confirmed here too.
  try {
    const ownerRow = await adminDb.admin_users.findUnique({
      where: { id: session.userId },
      select: { username: true, is_active: true, is_owner: true },
    });
    if (
      ownerRow?.is_active &&
      ((ownerRow.username ?? "").trim().toLowerCase() === "motha" ||
        ownerRow.is_owner === true)
    ) {
      return;
    }
  } catch {
    // P2022 (column missing) / transient fault → fail-closed: fall through to
    // the capability check below. No owner power granted on a read failure.
  }

  if (!hasCapability(perms.allowed_pages, capability)) {
    throw new Error(`You do not have permission to ${actionLabel}`);
  }
}
