import "server-only";

import { adminDb } from "@/lib/admin-db";
import { getDb } from "@/lib/db";

export type UserTagValue =
  | "contacted_vip"
  | "confirmed_vip"
  | "wager_abuser"
  | "fraud_abuser";

/** Tags surfaced together on Creator Hub → Wager / Fraud Abusers. */
export const ABUSER_HUB_TAGS: UserTagValue[] = ["wager_abuser", "fraud_abuser"];

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
    // The tag column is constrained to the allow-listed values by the
    // DB CHECK constraint; cast is safe.
    tag: r.tag as UserTagValue,
    setByAdminId: r.set_by_admin_id,
    setByAdminUsername: r.admin_user?.username ?? null,
    createdAt: r.created_at.toISOString(),
  }));
}

export type TaggedUserRow = {
  userId: string;
  username: string | null;
  email: string | null;
  tag: UserTagValue;
  taggedAt: string;
  setByAdminUsername: string | null;
};

/**
 * Lists packy.gg users who have a specific admin tag. Reads tag rows
 * from the admin DB (indexed on `tag`), then hydrates username/email
 * from the main DB in one batch lookup.
 */
export async function getUsersWithTags(
  tags: readonly UserTagValue[],
  { limit, offset }: { limit: number; offset: number },
): Promise<{ items: TaggedUserRow[]; total: number }> {
  const [tagRows, total] = await Promise.all([
    adminDb.admin_user_tags.findMany({
      where: { tag: { in: [...tags] } },
      include: {
        admin_user: { select: { username: true } },
      },
      orderBy: { created_at: "desc" },
      skip: offset,
      take: limit,
    }),
    adminDb.admin_user_tags.count({ where: { tag: { in: [...tags] } } }),
  ]);

  if (tagRows.length === 0) {
    return { items: [], total };
  }

  const db = await getDb();
  const users = await db.user.findMany({
    where: { id: { in: tagRows.map((r) => r.target_user_id) } },
    select: { id: true, username: true, email: true },
  });
  const userById = new Map(users.map((u) => [u.id, u]));

  return {
    items: tagRows.map((r) => {
      const user = userById.get(r.target_user_id);
      return {
        userId: r.target_user_id,
        username: user?.username ?? null,
        email: user?.email ?? null,
        taggedAt: r.created_at.toISOString(),
        setByAdminUsername: r.admin_user?.username ?? null,
        tag: r.tag as UserTagValue,
      };
    }),
    total,
  };
}

export async function getUsersWithTag(
  tag: UserTagValue,
  paging: { limit: number; offset: number },
): Promise<{ items: TaggedUserRow[]; total: number }> {
  return getUsersWithTags([tag], paging);
}
