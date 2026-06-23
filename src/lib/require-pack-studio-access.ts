import { redirect } from "next/navigation";

import {
  verifySession,
  getUserPermissions,
  sessionRoles,
} from "@/lib/dal";
import { getDefaultRouteForRoles } from "@/lib/admin-roles";
import { adminDb } from "@/lib/admin-db";
import {
  canAccessPackStudio,
  getPackStudioAccessSettings,
  PACK_STUDIO_TOGGLE_ROLES,
  type PackStudioAccessSettings,
} from "@/lib/pack-studio-access";
import type { SessionPayload } from "@/lib/session";
import { isNextControlFlowError } from "@/lib/utils/action-error";

/**
 * Shared Pack-Studio access gates — the same rule as the layout
 * (`canAccessPackStudio`: an owner, or a role whose ADMIN-DB toggle is on).
 * Pages redirect on denial; server actions throw so callers can surface a
 * toast. Modeled 1:1 on `@/lib/require-creator-hub-access`.
 */

async function loadSettingsFailClosed(): Promise<PackStudioAccessSettings> {
  try {
    return await getPackStudioAccessSettings();
  } catch (err) {
    if (isNextControlFlowError(err)) throw err;
    console.error(
      "[require-pack-studio-access] getPackStudioAccessSettings failed, denying non-owner access:",
      err,
    );
    return Object.fromEntries(
      PACK_STUDIO_TOGGLE_ROLES.map((role) => [role, false]),
    ) as PackStudioAccessSettings;
  }
}

async function resolveLiveSession(): Promise<{
  session: SessionPayload;
  username: string | null;
  active: boolean;
}> {
  const session = await verifySession();
  const user = await adminDb.admin_users.findUnique({
    where: { id: session.userId },
    select: { username: true, is_active: true },
  });
  return {
    session,
    username: user?.username ?? null,
    active: user?.is_active === true,
  };
}

async function isPackStudioAllowed(
  session: SessionPayload,
  username: string | null,
  active: boolean,
): Promise<boolean> {
  if (!active || !username) return false;
  const settings = await loadSettingsFailClosed();
  return canAccessPackStudio(
    {
      username,
      role: session.role,
      roles: session.roles,
      isOwner: session.isOwner,
    },
    settings,
  );
}

/** Page-level gate — redirects non-eligible viewers to their landing route. */
export async function requirePackStudioPageAccess(): Promise<SessionPayload> {
  const { session, username, active } = await resolveLiveSession();
  if (!(await isPackStudioAllowed(session, username, active))) {
    const allowedPages = await getUserPermissions(session.userId);
    redirect(getDefaultRouteForRoles(sessionRoles(session), allowedPages));
  }
  return session;
}

/** Server-action gate — throws on denial (never redirects from an action). */
export async function requirePackStudioAccess(
  unauthorizedMessage = "Not authorized to access Pack Studio.",
): Promise<SessionPayload> {
  const { session, username, active } = await resolveLiveSession();
  if (!(await isPackStudioAllowed(session, username, active))) {
    throw new Error(unauthorizedMessage);
  }
  return session;
}
