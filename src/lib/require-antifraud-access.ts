import { cache } from "react";
import { redirect } from "next/navigation";
import { headers } from "next/headers";

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
import {
  appendAntifraudSecurityAudit,
  beginAntifraudAction,
} from "@/lib/antifraud/security-audit";

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
const auditAllowedPage = cache(
  async (session: SessionPayload, username: string): Promise<void> => {
    const requestHeaders = await headers();
    const path = requestHeaders.get("x-antifraud-path") ?? "/antifraud";
    await appendAntifraudSecurityAudit({
      actorAdminUserId: session.userId,
      actorUsername: username,
      actorRoles: sessionRoles(session),
      sessionRef: `${session.userId}:${session.iat ?? 0}`,
      eventKind: "view",
      action: `antifraud.view:${path}`,
      outcome: "allowed",
    });
    const searchKeys = requestHeaders.get("x-antifraud-search-keys");
    if (searchKeys) {
      await appendAntifraudSecurityAudit({
        actorAdminUserId: session.userId,
        actorUsername: username,
        actorRoles: sessionRoles(session),
        sessionRef: `${session.userId}:${session.iat ?? 0}`,
        eventKind: "search",
        action: `antifraud.search:${path}`,
        outcome: "allowed",
        metadata: { parameterKeys: searchKeys.split(",") },
      });
    }
  },
);

async function auditDeniedAccess(
  session: SessionPayload,
  username: string | null,
  kind: "view" | "action",
): Promise<void> {
  try {
    await appendAntifraudSecurityAudit({
      actorAdminUserId: session.userId,
      actorUsername: username,
      actorRoles: sessionRoles(session),
      sessionRef: `${session.userId}:${session.iat ?? 0}`,
      eventKind: kind,
      action: `antifraud.${kind}`,
      outcome: "denied",
      reasonCode: "workspace_access_denied",
    });
  } catch {
    console.error("[antifraud-security] denied-access audit unavailable");
  }
}

export async function requireAntifraudPageAccess(): Promise<SessionPayload> {
  const { session, username, active } = await resolveLiveSession();
  if (!(await isAntifraudAllowed(session, username, active))) {
    await auditDeniedAccess(session, username, "view");
    const allowedPages = await getUserPermissions(session.userId);
    redirect(getDefaultRouteForRoles(sessionRoles(session), allowedPages));
  }
  await auditAllowedPage(session, username!);
  return session;
}

/**
 * Read-only API gate for authenticated GET/stream routes.
 *
 * EventSource does not reliably send an Origin header for a same-origin GET.
 * Reusing the Server Action gate here therefore rejects a valid live stream
 * before the route can apply its own Fetch Metadata and Origin checks. Keep
 * role/account authorization shared, while the individual route owns its
 * read-specific CSRF and rate-limit policy.
 */
export async function requireAntifraudReadAccess(
  unauthorizedMessage = "Not authorized to access the Antifraud workspace.",
): Promise<SessionPayload> {
  const { session, username, active } = await resolveLiveSession();
  if (!(await isAntifraudAllowed(session, username, active))) {
    await auditDeniedAccess(session, username, "view");
    throw new Error(unauthorizedMessage);
  }
  return session;
}

/** Server-action gate — throws on denial (never redirects from an action). */
export async function requireAntifraudAccess(
  unauthorizedMessage = "Not authorized to access the Antifraud workspace.",
): Promise<SessionPayload> {
  const { session, username, active } = await resolveLiveSession();
  if (!(await isAntifraudAllowed(session, username, active))) {
    await auditDeniedAccess(session, username, "action");
    throw new Error(unauthorizedMessage);
  }
  const requestHeaders = await headers();
  const origin = requestHeaders.get("origin");
  const host = requestHeaders.get("host");
  let sameOrigin = false;
  try {
    sameOrigin =
      Boolean(origin && host) &&
      new URL(origin!).host.toLowerCase() === host!.toLowerCase();
  } catch {
    sameOrigin = false;
  }
  if (!sameOrigin) {
    try {
      await appendAntifraudSecurityAudit({
        actorAdminUserId: session.userId,
        actorUsername: username,
        actorRoles: sessionRoles(session),
        sessionRef: `${session.userId}:${session.iat ?? 0}`,
        eventKind: "action",
        action: "antifraud.server_action",
        outcome: "denied",
        reasonCode: "origin_mismatch",
      });
    } finally {
      throw new Error("This Antifraud action must come from the current dashboard.");
    }
  }
  await beginAntifraudAction({
    actorAdminUserId: session.userId,
    actorUsername: username,
    actorRoles: sessionRoles(session),
    sessionRef: `${session.userId}:${session.iat ?? 0}`,
    action: "antifraud.server_action",
    limitPerMinute: 90,
  });
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

/**
 * Manage gate for READ paths that run during a page render (a Server Component
 * awaiting a query helper) rather than inside a Server Action.
 *
 * Do NOT reach for `requireAntifraudManager` here: that one layers the action
 * policy on top — same-origin `Origin` check plus the per-minute action rate
 * limit. A page GET carries no `Origin` header, so the same-origin test always
 * fails and the helper throws on every render, taking the whole page down.
 */
export async function requireAntifraudManagerRead(
  unauthorizedMessage = "Only owners and admins can view this Antifraud page.",
): Promise<SessionPayload> {
  const session = await requireAntifraudReadAccess(unauthorizedMessage);
  if (!canManageAntifraud(session)) throw new Error(unauthorizedMessage);
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
