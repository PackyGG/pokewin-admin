import "server-only";

import { cache } from "react";

import { adminDb } from "@/lib/admin-db";
import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";

/**
 * Cached read of the excluded-users blacklist. Returns the bare list
 * of packy.gg user_ids that should be filtered out of dashboard /
 * analytics / PnL / wager aggregates.
 *
 * Cached via React's `cache()` so per-request the admin DB is hit
 * exactly once, regardless of how many call sites consult the list
 * inside a single page render. Failures degrade to an empty list +
 * a console.error — better to show metrics with stale exclusions
 * than to crash every analytics page on an admin DB blip.
 */
export const getExcludedUserIds = cache(async (): Promise<string[]> => {
  try {
    const rows = await adminDb.excluded_users.findMany({
      select: { user_id: true },
    });
    return rows.map((r) => r.user_id);
  } catch (e) {
    console.error(
      "[excluded-users] failed to read blacklist — falling back to empty list:",
      e,
    );
    return [];
  }
});

/**
 * Full row data for the management page (`/system/excluded-users`).
 * Includes the admin who added each entry, so the table can show
 * "added by X on date Y, reason Z".
 *
 * `totalDeposited` is the user's lifetime deposit total
 * (`balances.total_deposited` in the main game DB) — surfaced next to
 * the user ID so an operator can gauge how much volume the exclusion
 * removes from analytics.
 *
 * Not cached — the page wants live data after add / remove server
 * actions revalidate the route.
 */
export type ExcludedUserRow = {
  userId: string;
  reason: string | null;
  excludedByUsername: string;
  createdAt: string;
  totalDeposited: number;
};

export async function getExcludedUsersForPage(): Promise<ExcludedUserRow[]> {
  const rows = await adminDb.excluded_users.findMany({
    orderBy: { created_at: "desc" },
    include: {
      admin_user: { select: { username: true } },
    },
  });

  // The blacklist lives in the admin DB, but each user's lifetime
  // deposit total lives on `balances` in the main game DB. No cross-DB
  // joins — pull the balances rows separately in a single batched
  // query and merge by user_id. A user with no balances row (never
  // deposited / no balance ever created) maps to 0.
  const userIds = rows.map((r) => r.user_id);
  const depositByUserId = new Map<string, number>();
  if (userIds.length > 0) {
    const db = await getDb();
    const balanceRows = await db.balances.findMany({
      where: { user_id: { in: userIds } },
      select: { user_id: true, total_deposited: true },
    });
    for (const b of balanceRows) {
      depositByUserId.set(b.user_id, toNumber(b.total_deposited));
    }
  }

  return rows.map((r) => ({
    userId: r.user_id,
    reason: r.reason,
    excludedByUsername: r.admin_user?.username ?? "(unknown)",
    createdAt: r.created_at.toISOString(),
    totalDeposited: depositByUserId.get(r.user_id) ?? 0,
  }));
}
