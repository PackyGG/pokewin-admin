"use server";

import { requireStaffAccess } from "@/lib/staff/access";
import { recordStaffPresence } from "@/lib/staff/profile";

export async function recordCurrentStaffPresence(): Promise<void> {
  const session = await requireStaffAccess();
  await recordStaffPresence(session.userId);
}
