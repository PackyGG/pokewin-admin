import { cache } from "react";
import { redirect } from "next/navigation";

import { verifySession, getUserPermissions, sessionRoles } from "@/lib/dal";
import { getDefaultRouteForRoles } from "@/lib/admin-roles";
import { eq } from "drizzle-orm";
import { adminDrizzle } from "@/lib/admin-db";
import { admin_users } from "@/lib/db-schema/admin/schema";
import {
  canAccessAntifraud,
  canManageAntifraud,
  deniedAntifraudSettings,
  getAntifraudAccessSettings,
  getAntifraudUserAccess,
  unavailableAntifraudUserAccess,
  type AntifraudAccessSettings,
  type AntifraudUserAccess,
} from "@/lib/antifraud/access";
import type { SessionPayload } from "@/lib/session";
import { isNextControlFlowError } from "@/lib/utils/action-error";

/**
 * Shared Antifraud access gates — the same rule the layout uses
 * (`canAccessAntifraud`: an owner, an admin, an allowlisted username, or a role
 * whose ADMIN-DB toggle is on). Pages redirect on denial; server actions throw
 * so callers can surface a toast. Modeled 1:1 on
 * `@/lib/require-pack-studio-access`.
 *
 * The MANAGE gate on top (`requireAntifraudManager`) protects workspace
 * settings: owners + admins only.
 */

async function loadSettingsFailClosed(): Promise<AntifraudAccessSettings> {
  try {
    return await getAntifraudAccessSettings();
  } catch (err) {
    if (isNextControlFlowError(err)) throw err;
    console.error(
      "[require-antifraud-access] getAntifraudAccessSettings failed, denying toggle-based access:",
      err,
    );
    return deniedAntifraudSettings();
  }
}
/**
 * Per-username allow/deny override read. A read failure must NOT silently
 * widen access (empty allowlist) and must NOT silently restore access for
 * someone the owner revoked (empty denylist means a blip cannot turn a deny
 * into an allow — the role default still decides). Net effect: fall back to
 * the role-only default + owner bypass.
 */
async function loadUserAccessFailClosed(): Promise<AntifraudUserAccess> {
  try {
    return await getAntifraudUserAccess();
  } catch (err) {
    if (isNextControlFlowError(err)) throw err;
    console.error(
      "[require-antifraud-access] getAntifraudUserAccess failed, denying non-owner access:",
      err,
    );
    return unavailableAntifraudUserAccess();
  }
}

/**
 * `React.cache`-wrapped: one request can hit this several times (layout gate →
 * page gate → an action gate inside a data helper), and each call would
 * otherwise pay its own DB-fresh username read. Server actions run as their own
 * request, so every action still re-verifies against the DB.
 */
const resolveLiveSession = cache(
  async (): Promise<{
    session: SessionPayload;
    username: string | null;
    active: boolean;
  }> => {
    const session = await verifySession();
    const [user] = await adminDrizzle.select({
      username: admin_users.username, is_active: admin_users.is_active,
    }).from(admin_users).where(eq(admin_users.id, session.userId)).limit(1);
    return {
      session,
      username: user?.username ?? null,
      active: user?.is_active === true,
    };
  },
);

async function isAntifraudAllowed(
  session: SessionPayload,
  username: string | null,
  active: boolean,
): Promise<boolean> {
  if (!active || !username) return false;
  const [settings, userAccess] = await Promise.all([
    loadSettingsFailClosed(),
    loadUserAccessFailClosed(),
  ]);
  return canAccessAntifraud(
    {
      username,
      role: session.role,
      roles: session.roles,
      isOwner: session.isOwner,
    },
    settings,
    userAccess,
  );
}

/** Page-level gate — redirects non-eligible viewers to their landing route. */
export async function requireAntifraudPageAccess(): Promise<SessionPayload> {
  const { session, username, active } = await resolveLiveSession();
  if (!(await isAntifraudAllowed(session, username, active))) {
    const allowedPages = await getUserPermissions(session.userId);
    redirect(getDefaultRouteForRoles(sessionRoles(session), allowedPages));
  }
  return session;
}

/** Server-action gate — throws on denial (never redirects from an action). */
export async function requireAntifraudAccess(
  unauthorizedMessage = "Not authorized to access the Antifraud workspace.",
): Promise<SessionPayload> {
  const { session, username, active } = await resolveLiveSession();
  if (!(await isAntifraudAllowed(session, username, active))) {
    throw new Error(unauthorizedMessage);
  }
  return session;
}

/**
 * Manage gate (owners + admins) for workspace settings.
 * Page variant redirects into the workspace root rather than out of it — a
 * staff member who clicks a settings deep-link lands somewhere useful.
 */
export async function requireAntifraudManagerPage(): Promise<SessionPayload> {
  const session = await requireAntifraudPageAccess();
  if (!canManageAntifraud(session)) redirect("/antifraud");
  return session;
}

/** Server-action manage gate — throws on denial. */
export async function requireAntifraudManager(
  unauthorizedMessage = "Only owners and admins can manage the Antifraud workspace.",
): Promise<SessionPayload> {
  const session = await requireAntifraudAccess(unauthorizedMessage);
  if (!canManageAntifraud(session)) throw new Error(unauthorizedMessage);
  return session;
}
