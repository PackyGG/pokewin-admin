import { eq } from "drizzle-orm";
import { adminDrizzle } from "@/lib/admin-db";
import { admin_users } from "@/lib/db-schema/admin/schema";
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
    async () => {
      const [row] = await adminDrizzle.select({
        role: admin_users.role, roles: admin_users.roles,
        allowed_pages: admin_users.allowed_pages,
      }).from(admin_users).where(eq(admin_users.id, session.userId)).limit(1);
      return row ?? null;
    },
    async () => {
      const [row] = await adminDrizzle.select({
        role: admin_users.role, allowed_pages: admin_users.allowed_pages,
      }).from(admin_users).where(eq(admin_users.id, session.userId)).limit(1);
      return row ?? null;
    },
  );

  if (!perms) {
    throw new Error(`You do not have permission to ${actionLabel}`);
  }
  // Defence in depth: re-derive admin from the DB row too (the session
  // shape is caller-supplied — never trust it alone for the bypass).
  if (getEffectiveRoles(perms.role, perms.roles).includes("admin")) return;

  // Defence in depth for the owner bypass: re-read username + is_owner from the
  // DB so a thin / spoofed caller session can't slip past, mirroring the admin
  // re-derivation above. Missing-column safe (the column may be absent on an un-migrated
  // DB) → degrades to non-owner so it can only ever DENY, never grant. The
  // permanent `motha` username owner is re-confirmed here too.
  try {
    const [ownerRow] = await adminDrizzle.select({
      username: admin_users.username, is_active: admin_users.is_active,
      is_owner: admin_users.is_owner,
    }).from(admin_users).where(eq(admin_users.id, session.userId)).limit(1);
    if (
      ownerRow?.is_active &&
      ((ownerRow.username ?? "").trim().toLowerCase() === "motha" ||
        ownerRow.is_owner === true)
    ) {
      return;
    }
  } catch {
    // 42703 (column missing) / transient fault → fail-closed: fall through to
    // the capability check below. No owner power granted on a read failure.
  }

  if (!hasCapability(perms.allowed_pages ?? [], capability)) {
    throw new Error(`You do not have permission to ${actionLabel}`);
  }
}
