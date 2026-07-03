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
  canAccessPackStudio,
  getPackStudioAccessSettings,
  getPackStudioUserAccess,
  PACK_STUDIO_TOGGLE_ROLES,
  type PackStudioAccessSettings,
  type PackStudioUserAccess,
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

/**
 * Per-username allow/deny override read. A read failure must NOT silently
 * widen access (so default to empty allowlist) and must NOT silently restore
 * access for someone the owner has explicitly revoked (so default to empty
 * denylist on read failure means a DB blip cannot turn a deny into an
 * allow). Net effect: fall back to the role-only default + owner bypass —
 * the safest middle ground.
 */
async function loadUserAccessFailClosed(): Promise<PackStudioUserAccess> {
  try {
    return await getPackStudioUserAccess();
  } catch (err) {
    if (isNextControlFlowError(err)) throw err;
    console.error(
      "[require-pack-studio-access] getPackStudioUserAccess failed, falling back to role default:",
      err,
    );
    return { allowlist: [], denylist: [] };
  }
}

/**
 * `React.cache`-wrapped (PERF, R3): a single request can hit this up to 3×
 * (page gate → `requirePackStudioAccess` inside a data helper →
 * `requireRetuneOwner`), and each call was paying its own DB-fresh username
 * read. The request-scoped memo collapses those onto ONE read;
 * `verifySession` inside is already React-cached the same way. Server
 * actions run as their own request, so every action still re-verifies
 * against the DB — no cross-request staleness is introduced.
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

async function isPackStudioAllowed(
  session: SessionPayload,
  username: string | null,
  active: boolean,
): Promise<boolean> {
  if (!active || !username) return false;
  const [settings, userAccess] = await Promise.all([
    loadSettingsFailClosed(),
    loadUserAccessFailClosed(),
  ]);
  return canAccessPackStudio(
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
