import "server-only";

import { adminDb } from "@/lib/admin-db";
import { getDb } from "@/lib/db";
import { calculateUsersPnlBatch } from "./pnl";

export type UserTagValue = "vip" | "wager_abuser";

export type UserTagRow = {
  tag: UserTagValue;
  // Nullable: deleting the admin who set the tag NULLs this attribution
  // while preserving the tag itself (see admin-users deleteAdminUser).
  setByAdminId: string | null;
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
  /**
   * User-perspective lifetime P&L (positive = user in profit = house
   * liability = 🔴 rose; negative = user is down = house gain = 🟢
   * emerald), matching the sign `hydrateUserListPage` exposes on
   * `/users`. Null unless `includeFinancials` was requested — callers
   * that don't opt in (e.g. the Wager Abusers hub) never pay for the
   * PnL batch and never see stale zeros.
   */
  pnl: number | null;
  /** Lifetime deposits (`calculateUsersPnlBatch` `deposits` term). Null unless `includeFinancials`. */
  totalDeposited: number | null;
  /** Lifetime withdrawals (`calculateUsersPnlBatch` `withdrawals` term). Null unless `includeFinancials`. */
  totalWithdrawn: number | null;
  country: string | null;
  countryCode: string | null;
};

/**
 * Lists packy.gg users who have a specific admin tag. Reads tag rows
 * from the admin DB (indexed on `tag`), then hydrates username/email
 * from the main DB in one batch lookup.
 *
 * `country`/`countryCode` are plain scalar columns on the same PK-IN
 * `user` lookup this function already does, so they're always populated
 * for no extra cost. `includeFinancials` additionally opts into the
 * canonical per-user lifetime P&L batch (`calculateUsersPnlBatch`, the
 * same function `/users` uses for its PnL/Deposits/Withdrawals columns
 * — see src/lib/queries/users-list.ts hydrateUserListPage), a genuinely
 * separate and heavier round-trip across balances/inventory/vouchers/
 * ledger. Off by default so callers that only need the tag/username/
 * email shape (the Wager Abusers hub) don't pay for it. Both the tag
 * page and the financial batch stay bounded to the current page slice
 * (`limit`/`offset`), never the full tagged population.
 */
export async function getUsersWithTags(
  tags: readonly UserTagValue[],
  {
    limit,
    offset,
    includeFinancials = false,
  }: { limit: number; offset: number; includeFinancials?: boolean },
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

  const targetUserIds = tagRows.map((r) => r.target_user_id);
  const db = await getDb();
  // country/country_code are plain scalar columns on the same PK-IN row
  // lookup — selecting them costs nothing extra (no new query), so they're
  // always fetched. Only the PnL batch (a genuinely separate, heavier
  // round-trip across balances/inventory/vouchers/ledger) is gated behind
  // `includeFinancials`.
  const [users, pnlByUserId] = await Promise.all([
    db.user.findMany({
      where: { id: { in: targetUserIds } },
      select: {
        id: true,
        username: true,
        email: true,
        country: true,
        country_code: true,
      },
    }),
    includeFinancials
      ? calculateUsersPnlBatch(targetUserIds)
      : Promise.resolve(null),
  ]);
  const userById = new Map(users.map((u) => [u.id, u]));

  return {
    items: tagRows.map((r) => {
      const user = userById.get(r.target_user_id);
      const userPnl = pnlByUserId?.get(r.target_user_id) ?? null;
      return {
        userId: r.target_user_id,
        username: user?.username ?? null,
        email: user?.email ?? null,
        taggedAt: r.created_at.toISOString(),
        setByAdminUsername: r.admin_user?.username ?? null,
        tag: r.tag as UserTagValue,
        // House formula → user-perspective sign, same convention as
        // hydrateUserListPage's `pnl` field on /users.
        pnl: userPnl ? -userPnl.pnl : null,
        totalDeposited: userPnl?.deposits ?? null,
        totalWithdrawn: userPnl?.withdrawals ?? null,
        country: user?.country ?? null,
        countryCode: user?.country_code ?? null,
      };
    }),
    total,
  };
}

export async function getUsersWithTag(
  tag: UserTagValue,
  paging: { limit: number; offset: number; includeFinancials?: boolean },
): Promise<{ items: TaggedUserRow[]; total: number }> {
  return getUsersWithTags([tag], paging);
}
