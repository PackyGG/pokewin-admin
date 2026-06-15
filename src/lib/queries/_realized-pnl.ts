import { cache } from "react";
import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { withTiming } from "@/lib/observability/query-timings";
import { compareRealizedPnl } from "@/lib/clickhouse/comparison";
import { resolveAdminRead } from "@/lib/clickhouse/resolve-read";
import { getRealizedPnlSnapshotFromClickHouse } from "@/lib/clickhouse/queries/realized-pnl";
import { computeHousePnl } from "./pnl";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "./_blacklist";
import {
  officialStreamAdjustmentSqlPredicate,
  removeLockedBalanceAdjustmentSqlPredicate,
} from "@/lib/balance-adjustment-categories";

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
 * Withdrawal continuity: the `withdrawals` term counts card_withdrawal_requests
 * with status IN ('pending','processing','shipped','completed') — i.e.
 * in-flight withdrawals are a house liability, not just completed ones (see
 * WITHDRAWAL_LIABILITY_STATUSES in pnl.ts). Pending/processing value is held
 * as withdrawal-locked inventory, which the inventory subquery excludes
 * (withdrawal_locked_at IS NULL), so it is counted exactly once and the
 * lifetime P&L does not jump when a withdrawal moves pending → completed.
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
 * Per-request memoized via React `cache()`, AND cross-request cached
 * for 5 minutes via Next.js `unstable_cache`.
 *
 * The inner snapshot is the single heaviest query in the codebase — it
 * walks `balances`, `card_withdrawal_requests`, `user_inventory`,
 * `vouchers`, and `rakeback_claims` for every non-staff user to
 * compute lifetime house P&L. On the dashboard's 60s auto-refresh
 * this used to re-run the whole thing on every tick.
 *
 * The `revalidate: 300` (5 min) bound matches what an operator
 * actually needs: lifetime P&L doesn't move by more than a few dollars
 * minute-to-minute, so a 5-minute staleness is invisible to a human
 * but cuts the per-render cost from ~hundreds-of-ms to ~0 on cache
 * hits. The dashboard's wager / period-PnL numbers stay on the
 * uncached hot path so they still refresh every 60s.
 *
 * The cache key is static (no args) because the inner function reads
 * its own blacklist + dynamic state. The 5-min revalidate floor means
 * a blacklist change becomes visible within 5 minutes — acceptable
 * for an admin-only list.
 */
const cachedSnapshot = unstable_cache(
  realizedPnlSnapshotInner,
  ["realized-pnl-snapshot"],
  { revalidate: 300, tags: ["dashboard-lifetime"] },
);

export const getRealizedPnlSnapshot = cache(
  async (): Promise<RealizedPnlSnapshot> => {
    return withTiming("realizedPnl.snapshot", () => cachedSnapshot());
  },
);

async function realizedPnlSnapshotPg(): Promise<RealizedPnlSnapshot> {
  const db = await getDb();
  // Pull the blacklist alongside the role-based staff exclusion so
  // admin-managed exclusions (the /system/excluded-users page) drop
  // out of lifetime PnL too. Empty list → no extra filter, query
  // stays equivalent to the previous staff-only version. IDs are
  // packy.gg user_ids — already alphanumeric — but we double-up any
  // embedded single quote defensively before inlining.
  const excluded = await getExcludedUserIds();
  const blacklistFrag = blacklistNotInClause("id", excluded);
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
      official_stream_net: string;
      remove_locked_net: string;
    }[]
  >(`
    WITH real_users AS (
      SELECT id FROM "user" WHERE role NOT IN ('admin', 'support') ${blacklistFrag}
    )
    SELECT
      COALESCE((SELECT SUM(total_deposited::numeric)     FROM balances                 WHERE user_id IN (SELECT id FROM real_users)), 0)::text AS deposited,
      COALESCE((SELECT SUM(total_withdrawn::numeric)     FROM balances                 WHERE user_id IN (SELECT id FROM real_users)), 0)::text AS balance_withdrawn,
      COALESCE((SELECT SUM(total_value_usd::numeric)     FROM card_withdrawal_requests  WHERE status IN ('pending','processing','shipped','completed') AND user_id IN (SELECT id FROM real_users)), 0)::text AS card_withdrawn,
      COALESCE((SELECT SUM(available_balance::numeric)   FROM balances                 WHERE user_id IN (SELECT id FROM real_users)), 0)::text AS available_balance,
      COALESCE((SELECT SUM(locked_balance::numeric)      FROM balances                 WHERE user_id IN (SELECT id FROM real_users)), 0)::text AS locked_balance,
      COALESCE((SELECT SUM(value_at_obtained::numeric)   FROM user_inventory            WHERE sold_at IS NULL AND exchanged_at IS NULL AND withdrawal_locked_at IS NULL AND user_id IN (SELECT id FROM real_users)), 0)::text AS inventory,
      COALESCE((SELECT SUM(value::numeric)               FROM vouchers                  WHERE claimed_at IS NULL AND user_id IN (SELECT id FROM real_users)), 0)::text AS vouchers,
      COALESCE((SELECT SUM(rakeback_amount_usd::numeric) FROM rakeback_claims           WHERE claimed_at IS NULL AND user_id IN (SELECT id FROM real_users)), 0)::text AS unclaimed_rakeback,
      -- FAKE-BALANCE carve-out: official_stream adjustments credit REAL
      -- available_balance but are owner-designated fake balance. The live
      -- balance term above (available + locked) includes this credit, so
      -- subtract the SIGNED NET of every completed official_stream
      -- adjustment from userBalance before computing house P&L (a later
      -- clawback debit reverses it). NET (SUM(amount), not ABS) so the
      -- carve-out is self-reversing.
      COALESCE((SELECT SUM(amount::numeric) FROM ledger_transactions WHERE status = 'completed' AND ${officialStreamAdjustmentSqlPredicate()} AND user_id IN (SELECT id FROM real_users)), 0)::text AS official_stream_net,
      COALESCE((SELECT SUM(amount::numeric) FROM ledger_transactions WHERE status = 'completed' AND ${removeLockedBalanceAdjustmentSqlPredicate()} AND user_id IN (SELECT id FROM real_users)), 0)::text AS remove_locked_net
  `);

  const r = rows[0];
  const totalDeposited = Number(r?.deposited ?? 0);
  const balanceWithdrawn = Number(r?.balance_withdrawn ?? 0);
  const cardWithdrawn = Number(r?.card_withdrawn ?? 0);
  const totalWithdrawn = balanceWithdrawn + cardWithdrawn;
  const availableBalance = Number(r?.available_balance ?? 0);
  const lockedBalance = Number(r?.locked_balance ?? 0);
  const officialStreamNet = Number(r?.official_stream_net ?? 0);
  const removeLockedNet = Number(r?.remove_locked_net ?? 0);
  // Net out stats-excluded adjustments so they never enter the live-balance
  // P&L term (see SQL notes above).
  const userBalance =
    availableBalance + lockedBalance - officialStreamNet - removeLockedNet;
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

/**
 * CQRS serve-path inner for the `dashboard_realized_pnl_lifetime` surface (the
 * uncached computor — `cachedSnapshot` wraps it, so a CH failure in `clickhouse`
 * mode throws THROUGH the cache and degrades via the caller rather than caching
 * an error or re-running the heavy Postgres balance-sheet scan).
 *
 *   • clickhouse → serve the CH twin (SOLE read; on failure THROWS).
 *   • comparison → serve Postgres, fire-and-forget drift log (unchanged; the
 *     hook is single-arg lifetime and fetches its own blacklist).
 *   • off        → serve Postgres (today's behavior).
 *
 * Note: this snapshot reads via `getDb()` and is cached under a STATIC key (no
 * env arg), so it is already prod-oriented; the CH mirror (prod-only) is
 * consistent with that existing behavior.
 */
async function realizedPnlSnapshotInner(): Promise<RealizedPnlSnapshot> {
  return resolveAdminRead<RealizedPnlSnapshot>("dashboard_realized_pnl_lifetime", {
    pg: realizedPnlSnapshotPg,
    ch: async () => {
      const blacklist = await getExcludedUserIds();
      return getRealizedPnlSnapshotFromClickHouse(blacklist);
    },
    compare: (snapshot) => {
      void compareRealizedPnl(snapshot);
    },
  });
}
