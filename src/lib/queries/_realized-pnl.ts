import { cache } from "react";
import { getDb } from "@/lib/db";
import { withTiming } from "@/lib/observability/query-timings";
import { computeHousePnl } from "./pnl";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";

/**
 * Lifetime realized P&L from the house perspective — a balance-sheet snapshot.
 *
 * Single source of truth for the Dashboard and Analytics pages so the two
 * can never drift. Uses the canonical formula from `pnl.ts`:
 *
 *   housePnl = deposits − withdrawals − onSiteBalance − inventory − vouchers
 *
 * On top of that this snapshot subtracts an extra liability term — unclaimed
 * rakeback — because at the platform level we owe those balances even though
 * they aren't yet on the user's balance row. The per-user P&L (users-list /
 * users-detail) sticks to the canonical five terms so the User Detail page
 * stays in sync with what the user themselves would see.
 *
 * All aggregates exclude only the `admin` role. Creators are real
 * users — their wagers/deposits/payouts count in P&L like everyone
 * else (consistent with src/lib/queries/_exclude-staff.ts).
 */
export type RealizedPnlSnapshot = {
  pnl: number;
  totalDeposited: number;
  totalWithdrawn: number;
  userBalance: number;
  inventory: number;
  vouchers: number;
  unclaimedRakeback: number;
};

/**
 * Per-request memoized. The snapshot is called from BOTH
 * `getDashboardStats` and `getAnalyticsData` — when a request renders
 * both surfaces (or when a single render reaches into either bundle)
 * the React `cache()` wrapper ensures the heavy 8-aggregate raw query
 * runs once, not twice. Cross-request caching is intentionally NOT
 * added here: the snapshot tracks live balances and unclaimed
 * vouchers/rakeback, both of which can change between requests.
 */
export const getRealizedPnlSnapshot = cache(
  async (): Promise<RealizedPnlSnapshot> => {
    return withTiming("realizedPnl.snapshot", () => realizedPnlSnapshotInner());
  },
);

async function realizedPnlSnapshotInner(): Promise<RealizedPnlSnapshot> {
  const db = await getDb();
  // Pull the blacklist alongside the role-based staff exclusion so
  // admin-managed exclusions (the /system/excluded-users page) drop
  // out of lifetime PnL too. Empty list → no extra filter, query
  // stays equivalent to the previous staff-only version. IDs are
  // packy.gg user_ids — already alphanumeric — but we double-up any
  // embedded single quote defensively before inlining.
  const excluded = await getExcludedUserIds();
  const blacklistFrag =
    excluded.length > 0
      ? `AND id NOT IN (${excluded
          .map((id) => `'${id.replace(/'/g, "''")}'`)
          .join(",")})`
      : "";
  const rows = await db.$queryRawUnsafe<
    {
      deposited: string;
      balance_withdrawn: string;
      card_withdrawn: string;
      available_balance: string;
      locked_balance: string;
      inventory: string;
      vouchers: string;
      unclaimed_rakeback: string;
    }[]
  >(`
    WITH real_users AS (
      SELECT id FROM "user" WHERE role NOT IN ('admin', 'support') ${blacklistFrag}
    )
    SELECT
      COALESCE((SELECT SUM(total_deposited::numeric)     FROM balances                 WHERE user_id IN (SELECT id FROM real_users)), 0)::text AS deposited,
      COALESCE((SELECT SUM(total_withdrawn::numeric)     FROM balances                 WHERE user_id IN (SELECT id FROM real_users)), 0)::text AS balance_withdrawn,
      COALESCE((SELECT SUM(total_value_usd::numeric)     FROM card_withdrawal_requests  WHERE status IN ('completed','shipped') AND user_id IN (SELECT id FROM real_users)), 0)::text AS card_withdrawn,
      COALESCE((SELECT SUM(available_balance::numeric)   FROM balances                 WHERE user_id IN (SELECT id FROM real_users)), 0)::text AS available_balance,
      COALESCE((SELECT SUM(locked_balance::numeric)      FROM balances                 WHERE user_id IN (SELECT id FROM real_users)), 0)::text AS locked_balance,
      COALESCE((SELECT SUM(value_at_obtained::numeric)   FROM user_inventory            WHERE sold_at IS NULL AND exchanged_at IS NULL AND user_id IN (SELECT id FROM real_users)), 0)::text AS inventory,
      COALESCE((SELECT SUM(value::numeric)               FROM vouchers                  WHERE claimed_at IS NULL AND user_id IN (SELECT id FROM real_users)), 0)::text AS vouchers,
      COALESCE((SELECT SUM(rakeback_amount_usd::numeric) FROM rakeback_claims           WHERE claimed_at IS NULL AND user_id IN (SELECT id FROM real_users)), 0)::text AS unclaimed_rakeback
  `);

  const r = rows[0];
  const totalDeposited = Number(r?.deposited ?? 0);
  const balanceWithdrawn = Number(r?.balance_withdrawn ?? 0);
  const cardWithdrawn = Number(r?.card_withdrawn ?? 0);
  const totalWithdrawn = balanceWithdrawn + cardWithdrawn;
  const availableBalance = Number(r?.available_balance ?? 0);
  const lockedBalance = Number(r?.locked_balance ?? 0);
  const userBalance = availableBalance + lockedBalance;
  const inventory = Number(r?.inventory ?? 0);
  const vouchers = Number(r?.vouchers ?? 0);
  const unclaimedRakeback = Number(r?.unclaimed_rakeback ?? 0);

  // Canonical formula via shared helper, then subtract the global-only
  // unclaimed-rakeback liability. Keeps the arithmetic in one place across
  // the dashboard/analytics/per-user surfaces.
  const pnl =
    computeHousePnl({
      deposits: totalDeposited,
      withdrawals: totalWithdrawn,
      onSiteBalance: userBalance,
      inventoryValue: inventory,
      unclaimedVouchers: vouchers,
    }) - unclaimedRakeback;

  return {
    pnl,
    totalDeposited,
    totalWithdrawn,
    userBalance,
    inventory,
    vouchers,
    unclaimedRakeback,
  };
}
