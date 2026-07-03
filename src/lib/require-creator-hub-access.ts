import { cache } from "react";
import { redirect } from "next/navigation";

import {
  verifySession,
  getUserPermissions,
  sessionRoles,
} from "@/lib/dal";
import { getDefaultRouteForRoles } from "@/lib/admin-roles";
import { adminDb } from "@/lib/admin-db";
import {
  canAccessCreatorHub,
  getCreatorHubAccessSettings,
  CREATOR_HUB_TOGGLE_ROLES,
  type CreatorHubAccessSettings,
} from "@/lib/creator-hub-access";
import type { SessionPayload } from "@/lib/session";
import { isNextControlFlowError } from "@/lib/utils/action-error";

/**
 * Shared Creator-Hub access gates — the same rule as the layout
 * (`canAccessCreatorHub`: founder `motha`, or a role whose ADMIN-DB toggle
 * is on). Pages redirect on denial; server actions throw so callers can
 * surface a toast.
 */

async function loadSettingsFailClosed(): Promise<CreatorHubAccessSettings> {
  try {
    return await getCreatorHubAccessSettings();
  } catch (err) {
    if (isNextControlFlowError(err)) throw err;
    console.error(
      "[require-creator-hub-access] getCreatorHubAccessSettings failed, denying non-owner access:",
      err,
    );
    return Object.fromEntries(
      CREATOR_HUB_TOGGLE_ROLES.map((role) => [role, false]),
    ) as CreatorHubAccessSettings;
  }
}

/**
 * `React.cache`-wrapped (PERF, mirrors a86eb024): a single request can hit
 * this more than once (page gate + `requireCreatorHubAccess` inside data
 * helpers), and each call was paying its own DB-fresh username read. The
 * request-scoped memo collapses those onto ONE read; `verifySession` inside
 * is already React-cached the same way. Server actions run as their own
 * request, so every action still re-verifies against the DB — no
 * cross-request staleness is introduced.
 */
const resolveLiveSession = cache(
  async (): Promise<{
    session: SessionPayload;
    username: string | null;
    active: boolean;
  }> => {
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
  },
);

async function isCreatorHubAllowed(
  session: SessionPayload,
  username: string | null,
  active: boolean,
): Promise<boolean> {
  if (!active || !username) return false;
  const settings = await loadSettingsFailClosed();
  return canAccessCreatorHub(
    { username, role: session.role, roles: session.roles },
    settings,
  );
}

/** Page-level gate — redirects non-eligible viewers to their landing route. */
export async function requireCreatorHubPageAccess(): Promise<SessionPayload> {
  const { session, username, active } = await resolveLiveSession();
  if (!(await isCreatorHubAllowed(session, username, active))) {
    const allowedPages = await getUserPermissions(session.userId);
    redirect(getDefaultRouteForRoles(sessionRoles(session), allowedPages));
  }
  return session;
}

/** Server-action gate — throws on denial (never redirects from an action). */
export async function requireCreatorHubAccess(
  unauthorizedMessage = "Not authorized to access Creator Hub.",
): Promise<SessionPayload> {
  const { session, username, active } = await resolveLiveSession();
  if (!(await isCreatorHubAllowed(session, username, active))) {
    throw new Error(unauthorizedMessage);
  }
  return session;
}
