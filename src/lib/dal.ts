import { cache } from "react";
import { redirect } from "next/navigation";
import { getSession, type SessionPayload } from "./session";
import { adminDb } from "./admin-db";
import { getDefaultRoute } from "./admin-roles";
import type { AdminRole } from "./admin-roles";

export { getDefaultRoute };
export type { AdminRole };

export const verifySession = cache(async (): Promise<SessionPayload> => {
  const session = await getSession();
  if (!session) redirect("/login");
  if (new Date(session.expiresAt) < new Date()) redirect("/login");

  // Check admin user is still active
  const adminUser = await adminDb.admin_users.findUnique({
    where: { id: session.userId },
    select: { is_active: true },
  });
  if (!adminUser?.is_active) {
    redirect("/login");
  }

  return session;
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
