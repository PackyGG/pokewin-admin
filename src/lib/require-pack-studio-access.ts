import { cache } from "react";
import { redirect } from "next/navigation";

import {
  verifySession,
  getUserPermissions,
  sessionRoles,
} from "@/lib/dal";
import { getDefaultRouteForRoles } from "@/lib/admin-roles";
import { eq } from "drizzle-orm";
import { adminDrizzle } from "@/lib/admin-db";
import { admin_users } from "@/lib/db-schema/admin/schema";
import { canAccessPackStudio } from "@/lib/pack-studio-access";
import type { SessionPayload } from "@/lib/session";

/**
 * Shared Pack-Studio access gates — the same rule as the layout
 * (`canAccessPackStudio`: owners, admins, and Pack Builders).
 * Pages redirect on denial; server actions throw so callers can surface a
 * toast. Modeled 1:1 on `@/lib/require-creator-hub-access`.
 */

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

function isPackStudioAllowed(
  session: SessionPayload,
  username: string | null,
  active: boolean,
): boolean {
  if (!active || !username) return false;
  return canAccessPackStudio(
    {
      username,
      role: session.role,
      roles: session.roles,
      isOwner: session.isOwner,
    },
  );
}

/** Page-level gate — redirects non-eligible viewers to their landing route. */
export async function requirePackStudioPageAccess(): Promise<SessionPayload> {
  const { session, username, active } = await resolveLiveSession();
  if (!isPackStudioAllowed(session, username, active)) {
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
  if (!isPackStudioAllowed(session, username, active)) {
    throw new Error(unauthorizedMessage);
  }
  return session;
}
