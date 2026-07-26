import { redirect } from "next/navigation";

import { sessionIsOwner, verifySession } from "@/lib/dal";
import type { SessionPayload } from "@/lib/session";

export function canManageStaff(session: SessionPayload): boolean {
  return session.role === "admin" || sessionIsOwner(session);
}

export async function requireStaffPage(): Promise<SessionPayload> {
  return verifySession();
}

export async function requireStaffAccess(): Promise<SessionPayload> {
  return verifySession();
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
  if (canManageStaff(session)) redirect("/staff");
  return session;
}

export async function requireStaffLearner(
  unauthorizedMessage = "Quizzes are only available to staff learners.",
): Promise<SessionPayload> {
  const session = await verifySession();
  if (canManageStaff(session)) throw new Error(unauthorizedMessage);
  return session;
}
