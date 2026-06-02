import { cache } from "react";
import { redirect } from "next/navigation";
import { getSession, type SessionPayload } from "./session";
import { adminDb } from "./admin-db";
import {
  getDefaultRoute,
  getDefaultRouteForRoles,
  getEffectiveRoles,
  pickPrimaryRole,
} from "./admin-roles";
import type { AdminRole } from "./admin-roles";

export { getDefaultRoute };
export type { AdminRole };

/**
 * The effective system-role set carried on a verified session. Always
 * non-empty for a valid user and ALWAYS contains `session.role`.
 * `verifySession` populates `roles` from the DB, but this helper stays
 * defensive: if an older cookie path produced a session without `roles`,
 * it falls back to `[role]`.
 */
export function sessionRoles(session: SessionPayload): AdminRole[] {
  return getEffectiveRoles(session.role, session.roles);
}

/** True if the user holds `role` among their effective roles. */
export function sessionHasRole(session: SessionPayload, role: AdminRole): boolean {
  return sessionRoles(session).includes(role);
}

/** True if the user holds the `admin` role (full-access bypass). */
export function sessionIsAdmin(session: SessionPayload): boolean {
  return sessionHasRole(session, "admin");
}

export const verifySession = cache(async (): Promise<SessionPayload> => {
  const session = await getSession();
  if (!session) redirect("/login");
  if (new Date(session.expiresAt) < new Date()) redirect("/login");

  // Always read current role(s) + active status from DB. The JWT may
  // contain a stale role set if the user was demoted/promoted after login
  // — relying on the JWT alone would let a demoted admin keep full access
  // until their session expires (up to 12h).
  const adminUser = await adminDb.admin_users.findUnique({
    where: { id: session.userId },
    select: { is_active: true, role: true, roles: true },
  });
  if (!adminUser?.is_active) {
    redirect("/login");
  }

  // Override the JWT role(s) with the DB truth so every downstream check
  // (requireAdmin, requireRole, requirePageAccess, sidebar filtering) uses
  // the current state, not the login-time snapshot. `roles` is the full
  // effective set; `role` is its highest-privilege primary member so the
  // singular field stays meaningful for the many call sites that read it.
  const effectiveRoles = getEffectiveRoles(adminUser.role, adminUser.roles);
  const primary = pickPrimaryRole(effectiveRoles);
  return { ...session, role: primary, roles: effectiveRoles };
});

/**
 * A non-admin user's effective permission set — the `allowed_pages`
 * array. It holds page routes ("/users") AND `__can_*` capability flags;
 * it is the single source of truth every gate reads. Real admins (the
 * `admin` role anywhere in their role set) get an empty array here (they
 * bypass all page/capability checks).
 *
 * For non-admins `allowed_pages` is materialized from their assigned
 * role preset plus per-user adjustments — see the role tooling in
 * src/app/(admin)/admin-users. With multi-role the baselines of EVERY
 * assigned role are unioned into `allowed_pages` (see the create flow +
 * the support / pack_creator self-heal), so a single array read here is
 * already the union of the user's roles.
 */
export const getUserPermissions = cache(async (userId: string): Promise<string[]> => {
  const user = await adminDb.admin_users.findUnique({
    where: { id: userId },
    select: { role: true, roles: true, allowed_pages: true },
  });
  if (!user) return [];
  // `admin` among the user's effective roles = full access, no page list.
  if (getEffectiveRoles(user.role, user.roles).includes("admin")) return [];
  return user.allowed_pages;
});

export const requireAdmin = cache(async (): Promise<SessionPayload> => {
  const session = await verifySession();
  // "admin" must be among the user's effective roles. A user without the
  // admin role — even if they hold several other roles — is NOT admin.
  if (!sessionIsAdmin(session)) {
    const allowedPages = await getUserPermissions(session.userId);
    redirect(getDefaultRouteForRoles(sessionRoles(session), allowedPages));
  }
  return session;
});

export async function requireRole(allowedRoles: AdminRole[]): Promise<SessionPayload> {
  const session = await verifySession();
  // Pass if ANY of the user's effective roles is in the allowed set.
  const roles = sessionRoles(session);
  if (!roles.some((r) => allowedRoles.includes(r))) {
    const allowedPages = await getUserPermissions(session.userId);
    redirect(getDefaultRouteForRoles(roles, allowedPages));
  }
  return session;
}

export async function requirePageAccess(pageKey: string): Promise<SessionPayload> {
  const session = await verifySession();
  if (sessionIsAdmin(session)) return session;

  const allowedPages = await getUserPermissions(session.userId);
  if (!allowedPages.includes(pageKey)) {
    redirect(getDefaultRouteForRoles(sessionRoles(session), allowedPages));
  }
  return session;
}

export async function getDefaultRouteForUser(userId: string, role: string): Promise<string> {
  // Re-read the full effective role set so a multi-role user lands on the
  // right surface (admin → /dashboard, support → /users, …). The `role`
  // argument is the login-time primary; the DB is authoritative.
  const user = await adminDb.admin_users.findUnique({
    where: { id: userId },
    select: { role: true, roles: true },
  });
  const roles = getEffectiveRoles(user?.role ?? role, user?.roles);
  if (roles.includes("admin")) return "/dashboard";
  const allowedPages = await getUserPermissions(userId);
  return getDefaultRouteForRoles(roles, allowedPages);
}
