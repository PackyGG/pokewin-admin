import "server-only";

import { unstable_cache } from "next/cache";
import { getReadDrizzleDb } from "@/lib/db";
import { queryRows } from "@/lib/drizzle-query";
import { readDbEnv } from "@/lib/db-env";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { excludeStaffAndBlacklistedSqlFromIds } from "./_blacklist";
import {
  kpiWindowToCutoff,
  type DashboardKpiWindow,
} from "./dashboard-period";
export type DashboardCashflow = {
  deposits: number;
  depositCount: number;
  withdrawals: number;
  withdrawalCount: number;
};

/**
 * Dashboard "Deposits / Withdrawals" KPI-box cash-flow — the Postgres
 * source-of-truth for the `dashboard_cashflow` surface.
 *
 * WHY THIS EXISTS (2026-07-02 reconciliation fix): the box previously
 * sourced its four cash-flow figures from the shared `getDashboardKpiStats`
 * aggregate (`getPeriodAggregates` — deposit `revenue` + card-withdrawal
 * `withdrawal`). That aggregate scopes deposits/withdrawals to the CUSTOMER
 * population (`role NOT IN ('admin','support','creator')`, i.e. CREATORS
 * DROPPED), because the same query also produces the customer-wager legs
 * where creator-on-stream play must be excluded. The "P&L Today" tile, by
 * contrast, reads `calculateWindowedPnl` whose cash-flow legs keep creators
 * (`role NOT IN ('admin','support')`) and add manual admin-adjustment
 * withdrawals. So the two surfaces — both labelled "today deposits /
 * withdrawals" — disagreed: the box was consistently LOWER by exactly the
 * creator deposits/withdrawals (+ any manual withdrawals) in the window.
 * (Live prod probe 2026-07-01: creator card withdrawals = $1,486.50/12 tx
 * and creator deposits = $412.93/3 tx accounted for the ENTIRE gap; manual
 * withdrawals were $0.)
 *
 * FIX: serve the box from the SAME cash-flow definition the P&L-Today tile
 * uses, so the two reconcile by construction, WITHOUT disturbing the shared
 * aggregate's creator-excluded wager / inline period-P&L math (which stays
 * creator-scoped on purpose). This module owns ONLY the box's cash-flow
 * leg — the wager / GGR / period-P&L boxes are untouched.
 *
 * Definition (mirrors `calculateWindowedPnl` cash legs — the frozen
 * money-math source of truth, which is NOT modified):
 *   • deposits   = SUM(ledger amount) WHERE type='deposit' AND
 *                  status='completed' AND created_at >= cutoff, scope =
 *                  real customers KEEPING creators (role NOT IN
 *                  ('admin','support') + excluded-users blacklist).
 *   • withdrawals = card-withdrawal outflow + |manual withdrawals|:
 *       – card_wd  = SUM(card_withdrawal_requests.total_value_usd) WHERE
 *                    status IN ('completed','shipped') AND
 *                    COALESCE(shipped_at, completed_at) >= cutoff, same scope.
 *       – manual_wd = |SUM(ledger amount)| of admin_balance_adjustment rows
 *                    tagged 'Manual withdrawal:%' that DEBIT the balance
 *                    (balance_after < balance_before), created_at >= cutoff,
 *                    same scope. (This is the exact `manualWd` leg
 *                    calculateWindowedPnl folds into its withdrawals total.)
 *   Counts pair 1:1 with the dollar figures so the box's "$X / N tx"
 *   subtitle stays internally consistent (card + manual withdrawal events).
 *
 * `idx_ledger_tx_created_at` (EXPLAIN ANALYZE on prod 2026-07-01: ~5–9 ms).
 * The card-withdrawal leg seq-scans `card_withdrawal_requests` (~1.7k-row
 * table, the planner's optimal choice — ~4.5 ms) — the SAME scan the prior
 * `getPeriodAggregates` withdrawals CTE already ran, just with the user
 * scope widened to keep creators. No new heavy read is introduced.
 */

/** Cutoff → Postgres cash-flow read (customer scope KEEPING creators). */
async function computeCashflow(
  cutoff: Date,
  blacklist: string[],
): Promise<DashboardCashflow> {
  return withTiming("dashboard.cashflowPg", async () => {
    const db = await getReadDrizzleDb();
    // Self-contained `user_id IN (SELECT id FROM "user" WHERE role NOT IN
    // ('admin','support') AND id NOT IN (...))` — the SAME real-customer
    // population calculateWindowedPnl's global scope uses (creators KEPT).
    const scopeLt = excludeStaffAndBlacklistedSqlFromIds(blacklist).replace(
      /^user_id\b/,
      "lt.user_id",
    );
    const scopeCwr = excludeStaffAndBlacklistedSqlFromIds(blacklist).replace(
      /^user_id\b/,
      "cwr.user_id",
    );

    type DepRow = { amt: string; cnt: string };
    type CardRow = { amt: string; cnt: string };
    type ManualRow = { amt: string; cnt: string };

    const [dep, card, manual] = await Promise.all([
      queryRows<DepRow[]>(db,
        `SELECT COALESCE(SUM(lt.amount::numeric), 0)::text AS amt,
                COUNT(*)::text AS cnt
         FROM ledger_transactions lt
         WHERE lt.status = 'completed'
           AND lt.type::text = 'deposit'
           AND lt.created_at >= $1
           AND ${scopeLt}`,
        cutoff,
      ),
      queryRows<CardRow[]>(db,
        `SELECT COALESCE(SUM(cwr.total_value_usd::numeric), 0)::text AS amt,
                COUNT(*)::text AS cnt
         FROM card_withdrawal_requests cwr
         WHERE cwr.status IN ('completed', 'shipped')
           AND COALESCE(cwr.shipped_at, cwr.completed_at) >= $1
           AND ${scopeCwr}`,
        cutoff,
      ),
      queryRows<ManualRow[]>(db,
        `SELECT COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS amt,
                COUNT(*)::text AS cnt
         FROM ledger_transactions lt
         WHERE lt.status = 'completed'
           AND lt.type::text = 'admin_balance_adjustment'
           AND lt.balance_after < lt.balance_before
           AND lt.description ILIKE 'Manual withdrawal:%'
           AND lt.created_at >= $1
           AND ${scopeLt}`,
        cutoff,
      ),
    ]);

    const deposits = toNumber(dep[0]?.amt);
    const depositCount = Number(dep[0]?.cnt ?? 0);
    const cardWd = toNumber(card[0]?.amt);
    const cardWdCount = Number(card[0]?.cnt ?? 0);
    const manualWd = toNumber(manual[0]?.amt);
    const manualWdCount = Number(manual[0]?.cnt ?? 0);

    return {
      deposits,
      depositCount,
      // Card + manual withdrawals — the exact composition of
      // calculateWindowedPnl's `withdrawals` total (|manualWd| + cardWd).
      withdrawals: cardWd + manualWd,
      withdrawalCount: cardWdCount + manualWdCount,
    };
  });
}

/**
 * Cross-request cached cash-flow. 60s TTL keyed on the window + its resolved
 * cutoff ISO (rolls over at 00:00 UTC for "today") + the serialized blacklist
 * — the SAME 60s activity cadence the "P&L Today" tile (dashboard-today-pnl)
 * and the rest of the dashboard's live boxes use, so the box tracks live
 * instead of appearing stuck. The blacklist is resolved OUTSIDE the cache
 * (it reads the admin DB) and passed in as a serializable arg, matching every
 * other cached dashboard aggregate.
 */
const cachedCashflow = unstable_cache(
  async (
    _window: DashboardKpiWindow,
    cutoffIso: string,
    blacklist: string[],
  ): Promise<DashboardCashflow> => {
    void _window; // cache-key discriminator only
    return computeCashflow(new Date(cutoffIso), blacklist);
  },
  ["dashboard-cashflow-pg-v1"],
  { revalidate: 60, tags: ["dashboard-activity"] },
);

/**
 * Postgres serve-path for the `dashboard_cashflow` surface's PG slice.
 * Resolves the blacklist + cutoff outside the cache, then hits the 60s cache
 * on prod (dev-toggled admins bypass to a live read, same as every other
 * dashboard cache wrapper).
 */
export async function getDashboardCashflowFromPostgres(
  window: DashboardKpiWindow,
  now: Date = new Date(),
): Promise<DashboardCashflow> {
  const cutoff = kpiWindowToCutoff(window, now);
  const cutoffIso = cutoff.toISOString();
  const blacklist = await getExcludedUserIds();
  const env = await readDbEnv();
  if (env !== "prod") return computeCashflow(cutoff, blacklist);
  return cachedCashflow(window, cutoffIso, blacklist);
}
