import { cache } from "react";
import { redirect } from "next/navigation";
import { getSession, type SessionPayload } from "./session";
import { adminDb } from "./admin-db";
import { getDefaultRoute } from "./admin-roles";
import type { AdminRole } from "./admin-roles";
import {
  SYSTEM_ROLE_CAPABILITIES,
  type CapabilityKey,
} from "./permissions";

export { getDefaultRoute };
export type { AdminRole };

export const verifySession = cache(async (): Promise<SessionPayload> => {
  const session = await getSession();
  if (!session) redirect("/login");
  if (new Date(session.expiresAt) < new Date()) redirect("/login");

  // Always read current role + active status from DB. The JWT may contain
  // a stale role if the user was demoted/promoted after login — relying on
  // the JWT role alone would let a demoted admin keep full access until
  // their session expires (up to 8h).
  const adminUser = await adminDb.admin_users.findUnique({
    where: { id: session.userId },
    select: { is_active: true, role: true },
  });
  if (!adminUser?.is_active) {
    redirect("/login");
  }

  // Override the JWT role with the DB role so all downstream checks
  // (requireAdmin, requirePageAccess, sidebar filtering) use the
  // current truth, not the login-time snapshot.
  return { ...session, role: adminUser.role };
});

export const getUserPermissions = cache(async (userId: string): Promise<string[]> => {
  const user = await adminDb.admin_users.findUnique({
    where: { id: userId },
    select: { role: true, allowed_pages: true },
  });
  if (!user || user.role === "admin") return [];
  return user.allowed_pages;
});

export const requireAdmin = cache(async (): Promise<SessionPayload> => {
  const session = await verifySession();
  if (session.role !== "admin") {
    const allowedPages = await getUserPermissions(session.userId);
    redirect(getDefaultRoute(session.role, allowedPages));
  }
  return session;
});

export async function requireRole(allowedRoles: AdminRole[]): Promise<SessionPayload> {
  const session = await verifySession();
  if (!allowedRoles.includes(session.role as AdminRole)) {
    const allowedPages = await getUserPermissions(session.userId);
    redirect(getDefaultRoute(session.role, allowedPages));
  }
  return session;
}

export async function requirePageAccess(pageKey: string): Promise<SessionPayload> {
  const session = await verifySession();
  if (session.role === "admin") return session;

  const allowedPages = await getUserPermissions(session.userId);
  if (!allowedPages.includes(pageKey)) {
    redirect(getDefaultRoute(session.role, allowedPages));
  }
  return session;
}

export async function getDefaultRouteForUser(userId: string, role: string): Promise<string> {
  if (role === "admin") return "/dashboard";
  const allowedPages = await getUserPermissions(userId);
  return getDefaultRoute(role, allowedPages);
}

// ---------------------------------------------------------------------------
// Granular capability helpers (additive — new custom-roles system)
// ---------------------------------------------------------------------------
//
// Resolution order for a session user:
//   1. If admin_users.role_id is set → use admin_roles.capabilities array.
//   2. Otherwise fall back to SYSTEM_ROLE_CAPABILITIES[session.role].
//
// This coexists with the legacy `allowed_pages` + hardcoded `requireRole()`
// checks — existing call sites are untouched. New code can opt in by
// calling requireCapabilityForPage() / hasCapability() instead.
//
// Raw SQL is used for the lookup so this module compiles cleanly before
// `admin:migrate` has been run (the generated Prisma client won't know
// about `role_id` / `admin_roles` until then). After migration the raw
// query returns the new columns; before migration it just yields null
// role_id and the system-role fallback kicks in.

type ResolvedCapabilities = {
  role: string;
  roleId: string | null;
  capabilities: ReadonlySet<CapabilityKey>;
};

type RoleLookupRow = {
  role: string;
  role_id: string | null;
  role_capabilities: string[] | null;
};

export const resolveSessionCapabilities = cache(
  async (userId: string): Promise<ResolvedCapabilities> => {
    let role = "creator";
    let roleId: string | null = null;
    let customCaps: string[] | null = null;

    try {
      const rows = await adminDb.$queryRawUnsafe<RoleLookupRow[]>(
        `SELECT u.role::text AS role,
                u.role_id::text AS role_id,
                r.capabilities AS role_capabilities
           FROM admin_users u
           LEFT JOIN admin_roles r ON r.id = u.role_id
           WHERE u.id = $1::uuid`,
        userId,
      );
      if (rows.length > 0) {
        role = rows[0].role;
        roleId = rows[0].role_id;
        customCaps = rows[0].role_capabilities;
      }
    } catch {
      // Pre-migration: columns don't exist yet. Fall back to the enum role
      // via the typed client. This keeps the helper safe to import before
      // the user runs admin:migrate.
      const user = await adminDb.admin_users.findUnique({
        where: { id: userId },
        select: { role: true },
      });
      if (user) role = user.role;
    }

    if (roleId && customCaps) {
      return {
        role,
        roleId,
        capabilities: new Set(customCaps as CapabilityKey[]),
      };
    }

    const systemRole = role as keyof typeof SYSTEM_ROLE_CAPABILITIES;
    const keys = SYSTEM_ROLE_CAPABILITIES[systemRole] ?? [];
    return {
      role,
      roleId: null,
      capabilities: new Set(keys),
    };
  },
);

/** Non-throwing check used by UI to conditionally render actions. */
export async function hasCapability(
  session: Pick<SessionPayload, "userId" | "role">,
  key: CapabilityKey,
): Promise<boolean> {
  if (session.role === "admin") return true;
  const resolved = await resolveSessionCapabilities(session.userId);
  if (resolved.role === "admin") return true;
  return resolved.capabilities.has(key);
}

/**
 * Enforce that the current session user has `key` for a PAGE (Server
 * Component) load. On failure, calls Next.js `redirect()` to the user's
 * default route — mirroring `requireAdmin` / `requirePageAccess`. Because
 * `redirect()` throws an internal Next signal that the framework handles,
 * this function never returns when access is denied.
 *
 * For server-action capability gating (where you want a catchable error
 * to surface a toast in the client), use `requireCapability` from
 * `@/lib/require-capability` instead. The two helpers intentionally diverge:
 *   • `requireCapabilityForPage` (this file)  → redirect-based, page-level
 *   • `requireCapability`        (other file) → throw-based,    action-level
 */
export async function requireCapabilityForPage(key: CapabilityKey): Promise<SessionPayload> {
  const session = await verifySession();
  if (session.role === "admin") return session;

  const resolved = await resolveSessionCapabilities(session.userId);
  if (resolved.role === "admin") return session;
  if (resolved.capabilities.has(key)) return session;

  const allowedPages = await getUserPermissions(session.userId);
  redirect(getDefaultRoute(session.role, allowedPages));
}
