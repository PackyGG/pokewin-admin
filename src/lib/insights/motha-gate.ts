import { redirect } from "next/navigation";
import { adminDb } from "@/lib/admin-db";
import { verifySession } from "@/lib/dal";
import type { SessionPayload } from "@/lib/session";

/**
 * Single-account allowlist for the Insights section (/insights/**, /ggr).
 * Only the `motha` admin can view or navigate these routes — tighter than
 * the salary founder allowlist (which also includes void + kotha).
 */
export const INSIGHTS_OWNER_USERNAMES = ["motha"] as const;

export async function requireInsightsOwner(): Promise<
  SessionPayload & { username: string }
> {
  const session = await verifySession();

  const user = await adminDb.admin_users.findUnique({
    where: { id: session.userId },
    select: { username: true, is_active: true },
  });

  if (!user?.is_active || !isInsightsOwnerUsername(user.username)) {
    redirect("/dashboard");
  }

  return { ...session, username: user.username };
}

/** Non-throwing variant for conditional UI bits. */
export async function canAccessInsights(userId: string): Promise<boolean> {
  const user = await adminDb.admin_users.findUnique({
    where: { id: userId },
    select: { username: true, is_active: true },
  });
  return Boolean(user?.is_active && isInsightsOwnerUsername(user.username));
}

export function isInsightsOwnerUsername(
  username: string | null | undefined,
): boolean {
  const lower = (username ?? "").toLowerCase();
  return INSIGHTS_OWNER_USERNAMES.some((u) => u === lower);
}
