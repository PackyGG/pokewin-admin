import { redirect } from "next/navigation";

import {
  verifySession,
  sessionRoles,
  getUserPermissions,
} from "@/lib/dal";
import { getDefaultRouteForRoles } from "@/lib/admin-roles";
import {
  canAccessCreatorHub,
  getCreatorHubAccessSettings,
} from "@/lib/creator-hub-access";
import { adminDb } from "@/lib/admin-db";
import type { SessionPayload } from "@/lib/session";

/**
 * Page-level Creator Hub gate — redirects non-eligible viewers to their
 * normal landing route (same contract as the Hub layout + settings page).
 */
export async function requireCreatorHubPageAccess(): Promise<SessionPayload> {
  const session = await verifySession();
  const accessSettings = await getCreatorHubAccessSettings();
  if (!canAccessCreatorHub(session, accessSettings)) {
    const allowedPages = await getUserPermissions(session.userId);
    redirect(getDefaultRouteForRoles(sessionRoles(session), allowedPages));
  }
  return session;
}

/**
 * Action-level Creator Hub gate — re-reads the live admin account and
 * throws when the caller cannot access the Hub.
 */
export async function requireCreatorHubActionAccess(): Promise<{
  userId: string;
  session: SessionPayload;
}> {
  const session = await verifySession();

  const user = await adminDb.admin_users.findUnique({
    where: { id: session.userId },
    select: { username: true, is_active: true },
  });
  if (!user?.is_active) {
    throw new Error("Not authorized.");
  }

  const settings = await getCreatorHubAccessSettings();
  const allowed = canAccessCreatorHub(
    {
      username: user.username,
      role: session.role,
      roles: session.roles,
    },
    settings,
  );
  if (!allowed) {
    throw new Error("Not authorized.");
  }

  return { userId: session.userId, session };
}
