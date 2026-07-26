import { redirect } from "next/navigation";

import {
  getUserPermissions,
  sessionHasRole,
  sessionIsOwner,
  sessionRoles,
  verifySession,
} from "@/lib/dal";
import { getDefaultRouteForRoles } from "@/lib/admin-roles";
import type { SessionPayload } from "@/lib/session";

export function canManageStaff(session: SessionPayload): boolean {
  return sessionHasRole(session, "admin") || sessionIsOwner(session);
}

export function canUseStaffProfile(session: SessionPayload): boolean {
  return sessionHasRole(session, "support");
}

export function canAccessStaff(session: SessionPayload): boolean {
  return canManageStaff(session) || canUseStaffProfile(session);
}

async function redirectToDefault(session: SessionPayload): Promise<never> {
  const allowedPages = await getUserPermissions(session.userId);
  redirect(getDefaultRouteForRoles(sessionRoles(session), allowedPages));
}

export async function requireStaffPage(): Promise<SessionPayload> {
  const session = await verifySession();
  if (!canAccessStaff(session)) return redirectToDefault(session);
  return session;
}

export async function requireStaffAccess(): Promise<SessionPayload> {
  const session = await verifySession();
  if (!canUseStaffProfile(session)) {
    throw new Error("Staff profiles are only available to support users.");
  }
  return session;
}

export async function requireStaffProfilePage(): Promise<SessionPayload> {
  const session = await verifySession();
  if (!canUseStaffProfile(session)) redirect("/staff");
  return session;
}

export async function requireStaffManagerPage(): Promise<SessionPayload> {
  const session = await verifySession();
  if (!canManageStaff(session)) redirect("/staff");
  return session;
}

export async function requireStaffManager(
  unauthorizedMessage = "Only owners and admins can manage staff.",
): Promise<SessionPayload> {
  const session = await verifySession();
  if (!canManageStaff(session)) throw new Error(unauthorizedMessage);
  return session;
}

export async function requireStaffLearnerPage(): Promise<SessionPayload> {
  const session = await verifySession();
  if (!canUseStaffProfile(session) || canManageStaff(session)) redirect("/staff");
  return session;
}

export async function requireStaffLearner(
  unauthorizedMessage = "Quizzes are only available to staff learners.",
): Promise<SessionPayload> {
  const session = await verifySession();
  if (!canUseStaffProfile(session) || canManageStaff(session)) {
    throw new Error(unauthorizedMessage);
  }
  return session;
}
