import "server-only";

import { adminDb } from "@/lib/admin-db";

export type UserTagValue = "contacted_vip" | "confirmed_vip";

export type UserTagRow = {
  tag: UserTagValue;
  setByAdminId: string;
  setByAdminUsername: string | null;
  createdAt: string;
};

/**
 * Fetches every VIP tag set on a single user. Returns oldest-first
 * so re-rendering the tag list keeps the order admins are used to
 * (the most recently added tag appears at the end). Joins to
 * `admin_users` to surface who set each tag — useful in the panel
 * tooltip and for forensic audit reads.
 */
export async function getUserTags(userId: string): Promise<UserTagRow[]> {
  const rows = await adminDb.admin_user_tags.findMany({
    where: { target_user_id: userId },
    include: {
      admin_user: { select: { username: true } },
    },
    orderBy: { created_at: "asc" },
  });

  return rows.map((r) => ({
    // The tag column is constrained to the two allow-listed values
    // by the DB CHECK constraint; cast is safe.
    tag: r.tag as UserTagValue,
    setByAdminId: r.set_by_admin_id,
    setByAdminUsername: r.admin_user?.username ?? null,
    createdAt: r.created_at.toISOString(),
  }));
}
