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
import { resolveLandingRoute } from "./role-landing";
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

/**
 * True if the session belongs to an OWNER / ultra-admin — a second full-access
 * bypass that sits ABOVE the role model (orthogonal to it). `session.isOwner`
 * is the DB-fresh `admin_users.is_owner` flag `verifySession` reads below; the
 * permanent ROOT owner `motha` is owner via a username bypass regardless of the
 * flag. Kept inline here (not imported from `src/lib/owners.ts`) because that
 * module imports `verifySession` from this file — importing it back would be a
 * cycle. The two predicates are kept byte-identical (username===motha ||
 * isOwner). Owners bypass every page + capability check, exactly like `admin`.
 */
export function sessionIsOwner(session: SessionPayload): boolean {
  return (
    (session.username ?? "").trim().toLowerCase() === "motha" ||
    session.isOwner === true
  );
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
  // PERF (R3): this runs in the ROOT LAYOUTS on every request, so the
  // role/active columns AND the Phase-D guard columns (sessions_valid_after /
  // totp_enabled / is_owner) are read in ONE findUnique on the happy path —
  // the previous two serial reads cost a full extra admin-DB round-trip per
  // page load. The resilience contract is unchanged: if ANY of the additive
  // columns is missing (P2022 — e.g. `roles` or a guard column not migrated
  // on some DB), we fall back to the EXACT legacy two-step read below, which
  // degrades each column independently (`roles` → `[]` → legacy `[role]`;
  // guard columns → safe no-op defaults). A transient non-schema fault
  // re-throws, exactly like the old role read did (the layouts' JWT
  // fallback catches it), so no failure mode is widened.
  let adminUser: {
    is_active: boolean;
    role: string;
    roles?: readonly string[] | null;
  } | null = null;
  let sessionsValidAfter: Date | null = null;
  let totpEnabled = true; // safe default: never bounce on a read failure
  // OWNER / ULTRA-ADMIN flag, read DB-fresh (NOT from the JWT) so a promote /
  // demote takes effect on the very next request — exactly like the role
  // re-read. Defaults to false (fail-closed): a missing `is_owner` column
  // (could ship ahead of code on some deploy) or any read failure degrades to
  // non-owner here, and the permanent `motha` bypass is applied separately on
  // the username (DB-independent) so the root owner can never be locked out.
  let isOwnerFlag = false;
  try {
    const row = await adminDb.admin_users.findUnique({
      where: { id: session.userId },
      select: {
        is_active: true,
        role: true,
        roles: true,
        sessions_valid_after: true,
        totp_enabled: true,
        is_owner: true,
      },
    });
    adminUser = row;
    sessionsValidAfter = row?.sessions_valid_after ?? null;
    totpEnabled = row?.totp_enabled ?? true;
    isOwnerFlag = row?.is_owner ?? false;
  } catch (err) {
    if (!isMissingColumnError(err)) throw err;

    // ── Legacy fallback (some additive column not migrated on this DB) ──────
    // Byte-equivalent to the pre-merge behaviour: the resilient role read
    // degrades a missing `roles` column to `roles: []` (which
    // `getEffectiveRoles` collapses to the legacy `[role]`), and the guard
    // columns are read SEPARATELY so a missing guard column can't perturb the
    // battle-tested role/active path.
    adminUser = await readAdminUserWithRoles(
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

    // ── Phase D safety guards (session revocation + mandatory 2FA) ──────────
    // If either guard column is absent the read degrades to the SAFE no-op
    // (no revocation, treat 2FA as satisfied) so the gate can NEVER lock out
    // a normal enrolled admin because of a schema gap. It must not throw on
    // this path.
    try {
      const guardRow = await adminDb.admin_users.findUnique({
        where: { id: session.userId },
        select: { sessions_valid_after: true, totp_enabled: true, is_owner: true },
      });
      sessionsValidAfter = guardRow?.sessions_valid_after ?? null;
      totpEnabled = guardRow?.totp_enabled ?? true;
      isOwnerFlag = guardRow?.is_owner ?? false;
    } catch (guardErr) {
      // P2022 (column missing) → degrade to the no-op defaults above. Any
      // OTHER error is also swallowed to the safe defaults: the role/active
      // read already succeeded, so a blip here must not white-screen the shell.
      if (!isMissingColumnError(guardErr)) {
        console.error("[dal] verifySession guard-column read failed:", guardErr);
      }
    }
  }

  if (!adminUser?.is_active) {
    redirect("/login");
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
  // `isOwner` is DB-fresh (the guard read above), overwriting whatever the JWT
  // carried — same freshness contract as `role`/`roles`. Owner-only gates +
  // the page/capability bypass + the sidebar all read it from the session.
  return { ...session, role: primary, roles: effectiveRoles, isOwner: isOwnerFlag };
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
  // Owner / ultra-admin bypass — sees every page, exactly like `admin`. Kept
  // as a SEPARATE early-return next to the admin bypass (not folded into it) so
  // the admin path is untouched.
  if (sessionIsAdmin(session) || sessionIsOwner(session)) return session;

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
  // `admin` (the one superuser) is a hard bypass — always /dashboard, NEVER a
  // per-role landing override (locked: admin routing is untouched).
  if (roles.includes("admin")) return "/dashboard";
  const allowedPages = await getUserPermissions(userId);

  // RoleV2 P4 — per-role landing override (NON-admins only). When a role this
  // user holds has a `landing_route` set AND valid AND actually reachable by
  // this user, land there instead of the default surface. NULL on every row =
  // byte-identical to today's routing (the resolver returns null → fall
  // through). Priority: the user's assigned custom role (role_id) wins, then
  // the primary built-in role's override. Validation + reachability guard
  // against redirect loops (never land a user where the gate would bounce
  // them). Wrapped so a landing read can NEVER break login routing.
  const landing = await resolveUserLandingRoute(userId, roles, allowedPages);
  if (landing) return landing;

  return getDefaultRouteForRoles(roles, allowedPages);
}

/**
 * Resolve the per-role landing override for a NON-admin user, or `null` to fall
 * through to the default routing. Reads the user's `role_id` (assigned custom
 * role) + the system rows for their effective built-in roles, picks the custom
 * role's `landing_route` first (then the primary built-in's), and only returns
 * it when it is a KNOWN admin page AND the user can actually reach it
 * (`pageAccessGranted` — a redirect-loop guard, since the target page's own
 * gate would otherwise bounce them). NULL/invalid/unreachable → `null`.
 *
 * Defensive: any read failure (e.g. the `landing_route` column not yet applied
 * on some DB) degrades to `null` so login routing is never broken.
 */
async function resolveUserLandingRoute(
  userId: string,
  roles: AdminRole[],
  allowedPages: string[],
): Promise<string | null> {
  try {
    const row = await adminDb.admin_users.findUnique({
      where: { id: userId },
      select: {
        role_id: true,
        custom_role: { select: { landing_route: true } },
      },
    });

    // Candidate landing routes in priority order: assigned custom role first,
    // then the primary built-in role's system-row override.
    const candidates: Array<string | null | undefined> = [];
    candidates.push(row?.custom_role?.landing_route);

    if (roles.length > 0) {
      const primary = pickPrimaryRole(roles);
      const systemRow = await adminDb.admin_roles.findUnique({
        where: { system_key: primary },
        select: { landing_route: true },
      });
      candidates.push(systemRow?.landing_route);
    }

    for (const candidate of candidates) {
      const resolved = resolveLandingRoute(candidate);
      // Only honor a target the user can actually reach (avoids a redirect loop
      // where the destination's own gate bounces them straight back).
      if (resolved && pageAccessGranted(allowedPages, resolved)) {
        return resolved;
      }
    }
    return null;
  } catch (err) {
    if (!isMissingColumnError(err)) {
      console.error("[dal] resolveUserLandingRoute failed:", err);
    }
    return null;
  }
}
