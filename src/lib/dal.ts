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
import { readAdminUserWithRoles, isMissingColumnError } from "./admin-user-roles";
import type { AdminRole } from "./admin-roles";
import { pageAccessGranted } from "./admin-pages";
import { isSessionRevoked, isMandatory2faEnabled } from "./admin-guards";

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
  //
  // This runs in the ROOT LAYOUT on every request, so it must NEVER throw
  // because the additive `roles` column hasn't been migrated yet. The
  // resilient read degrades to `roles: []` when the column is missing,
  // which `getEffectiveRoles` collapses to the legacy `[role]` — identical
  // behaviour to before multi-role shipped.
  const adminUser = await readAdminUserWithRoles(
    () =>
      adminDb.admin_users.findUnique({
        where: { id: session.userId },
        select: { is_active: true, role: true, roles: true },
      }),
    () =>
      adminDb.admin_users.findUnique({
        where: { id: session.userId },
        select: { is_active: true, role: true },
      }),
  );
  if (!adminUser?.is_active) {
    redirect("/login");
  }

  // ── Phase D safety guards (session revocation + mandatory 2FA) ──────────────
  // Read the two guard columns SEPARATELY from the role read above so a
  // missing column can't perturb the (already battle-tested) role/active path.
  // Both columns exist on prod, but if either is absent on some DB the read
  // degrades to the SAFE no-op (no revocation, treat 2FA as satisfied) so the
  // gate can NEVER lock out a normal enrolled admin because of a schema gap.
  // This runs in the root layout on every request — it must not throw on the
  // happy path.
  let sessionsValidAfter: Date | null = null;
  let totpEnabled = true; // safe default: never bounce on a read failure
  try {
    const guardRow = await adminDb.admin_users.findUnique({
      where: { id: session.userId },
      select: { sessions_valid_after: true, totp_enabled: true },
    });
    sessionsValidAfter = guardRow?.sessions_valid_after ?? null;
    totpEnabled = guardRow?.totp_enabled ?? true;
  } catch (err) {
    // P2022 (column missing) → degrade to the no-op defaults above. Any OTHER
    // error is also swallowed to the safe defaults: the role/active checks
    // already passed, so a transient blip here must not white-screen the shell.
    if (!isMissingColumnError(err)) {
      console.error("[dal] verifySession guard-column read failed:", err);
    }
  }

  // Guard 3 — real session revocation. If the account has a watermark and this
  // JWT was issued before it (force-expire / compromise response), the token is
  // dead → send to /login. `session.iat` comes from jose's `setIssuedAt()`.
  if (isSessionRevoked(session.iat, sessionsValidAfter)) {
    redirect("/login");
  }

  // Guard 4 — mandatory 2FA (flag-gated, default ON). A user who has NOT
  // enrolled in 2FA (`totp_enabled === false`) is pushed to the existing setup
  // route under the (auth) group. This is the DEFENSE-IN-DEPTH leg; the PRIMARY
  // enforcement is closing the password-only login bypass in
  // (auth)/login/actions.ts, so a non-enrolled user can't obtain a fresh
  // session in the first place. Two cooperating pieces make this redirect
  // loop-free for the (today empty) population it can fire for:
  //   • `src/middleware.ts` lets an authenticated-but-non-enrolled user STAY on
  //     /setup-2fa instead of bouncing them back to /dashboard, and
  //   • `(auth)/setup-2fa/page.tsx` mints a fresh pending-2FA session from the
  //     real admin_session when one is missing, so the QR renders.
  // Enrolled admins (every admin today, totp_enabled === true) NEVER reach this
  // branch, so neither the redirect nor the flag read can bounce them — a flag
  // read that degrades to ON only ever affects a non-enrolled user, who SHOULD
  // be sent to setup.
  if (!totpEnabled && (await isMandatory2faEnabled())) {
    redirect("/setup-2fa");
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
  // Resilient to the unapplied `roles` migration: degrades to `roles: []`
  // (→ effective `[role]`) so this read can't crash a non-admin's request.
  const user = await readAdminUserWithRoles(
    () =>
      adminDb.admin_users.findUnique({
        where: { id: userId },
        select: { role: true, roles: true, allowed_pages: true },
      }),
    () =>
      adminDb.admin_users.findUnique({
        where: { id: userId },
        select: { role: true, allowed_pages: true },
      }),
  );
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
  if (!pageAccessGranted(allowedPages, pageKey)) {
    redirect(getDefaultRouteForRoles(sessionRoles(session), allowedPages));
  }
  return session;
}

export async function getDefaultRouteForUser(userId: string, role: string): Promise<string> {
  // Re-read the full effective role set so a multi-role user lands on the
  // right surface (admin → /dashboard, support → /users, …). The `role`
  // argument is the login-time primary; the DB is authoritative. Resilient
  // to the unapplied `roles` migration → falls back to `[role]`.
  const user = await readAdminUserWithRoles(
    () =>
      adminDb.admin_users.findUnique({
        where: { id: userId },
        select: { role: true, roles: true },
      }),
    () =>
      adminDb.admin_users.findUnique({
        where: { id: userId },
        select: { role: true },
      }),
  );
  const roles = getEffectiveRoles(user?.role ?? role, user?.roles);
  if (roles.includes("admin")) return "/dashboard";
  const allowedPages = await getUserPermissions(userId);
  return getDefaultRouteForRoles(roles, allowedPages);
}
