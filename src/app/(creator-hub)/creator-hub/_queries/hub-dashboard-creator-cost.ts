import "server-only";

import { unstable_cache } from "next/cache";
import { getReadDrizzleDb } from "@/lib/db";
import { queryRows } from "@/lib/drizzle-query";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { type DashboardPeriod } from "@/lib/queries/dashboard-period";
import { hubPeriodToInterval, hubPeriodToSinceDate } from "./hub-period-sql";
import {
  getConvertedFillSessionsInWindow,
  sumConvertedFillSessions,
} from "@/lib/queries/creator-converted-sessions-in-window";

/**
 * Windowed creator cost for the Creator Hub dashboard — the SAME three
 * house-cost legs as `dashboard-creator-costs-today.ts`, re-scoped to the
 * active `DashboardPeriod` chip instead of calendar-today:
 *
 *   • Converted deal payouts (`creator_fill_conversion` vouchers minted in
 *     the window + multiplier payout vouchers minted in window).
 *   • House-funded creator tips (`creator_fill_spend_tip`).
 *   • Full affiliate leaderboard prize gross (`affiliate_leaderboard_prize`).
 *
 * `unstable_cache` keyed on the period label; cutoff computed at fill time
 * via `NOW() - INTERVAL` (same cache-key pattern as net GGR scans).
 */

export type HubCreatorCostLine = {
  key: string;
  label: string;
  amount: number;
};

export type HubCreatorCostBreakdown = {
  total: number;
  lines: HubCreatorCostLine[];
};

const cachedHubCreatorCost = unstable_cache(
  async (period: DashboardPeriod): Promise<HubCreatorCostBreakdown> => {
    return withTiming("creator-hub.creatorCost", async () => {
      const db = await getReadDrizzleDb();
      const interval = hubPeriodToInterval(period);
      const since = `NOW() - INTERVAL '${interval}'`;

      const sinceDate = hubPeriodToSinceDate(period);

      /**
       * ONE round-trip for the three SQL legs.
       *
       * These used to be three sequential `queryRows` calls. Every MAIN read
       * takes a mirror-pool permit AND (because mirror clients are retired at
       * `maxUses: 1`) a brand-new connection, so three serial statements cost
       * three handshakes and three slots out of a globally capped pool — on a
       * page that already runs a wide fan-out. Folding them into three scalar
       * subqueries keeps each leg's plan/index usage EXACTLY as it was (same
       * predicates, same filters) while paying for one checkout instead of
       * three. `NOW()` is the statement/transaction timestamp, so all three
       * windows now share one instant rather than drifting by the round-trip
       * latency between them — strictly more consistent, same figures.
       *
       * The voucher leg for `creator_fill_conversion` stays in the canonical
       * `getConvertedFillSessionsInWindow` helper (blacklist scope lives
       * there); it is now awaited CONCURRENTLY with this aggregate instead of
       * before it, so the cost breakdown is one wave rather than four.
       */
      type CostRow = {
        multiplier_payouts: string;
        tips: string;
        leaderboard_gross: string;
      };

      const [fillConverted, costRows] = await Promise.all([
        getConvertedFillSessionsInWindow(sinceDate)
          .then(sumConvertedFillSessions)
          .catch((err) => {
            console.error(
              "[creator-hub] fill converted sessions failed (cost uses tips+LB only):",
              err,
            );
            return 0;
          }),
        queryRows<CostRow[]>(db,
          `SELECT
             (SELECT COALESCE(SUM(v.value::numeric), 0)
                FROM vouchers v
               WHERE v.origin::text = 'creator_multiplier_payout'
                 AND v.created_at >= ${since})::text AS multiplier_payouts,
             (SELECT COALESCE(SUM(ABS(lt.amount::numeric)), 0)
                FROM ledger_transactions lt
               WHERE lt.status = 'completed'
                 AND lt.type::text = 'creator_fill_spend_tip'
                 AND lt.created_at >= ${since})::text AS tips,
             (SELECT COALESCE(SUM(ABS(lt.amount::numeric)), 0)
                FROM ledger_transactions lt
               WHERE lt.status = 'completed'
                 AND lt.type::text = 'affiliate_leaderboard_prize'
                 AND lt.created_at >= ${since})::text AS leaderboard_gross`,
        ),
      ]);

      const costs = costRows[0];
      const creatorWithdrawals =
        fillConverted + toNumber(costs?.multiplier_payouts);
      const tips = toNumber(costs?.tips);
      const leaderboardGross = toNumber(costs?.leaderboard_gross);

      const lines: HubCreatorCostLine[] = [
        {
          key: "converted_payouts",
          label: "Converted deal payouts",
          amount: creatorWithdrawals,
        },
        { key: "tips", label: "House-funded tips", amount: tips },
        {
          key: "leaderboard",
          label: "Leaderboard prizes (gross)",
          amount: leaderboardGross,
        },
      ];

      return {
        total: creatorWithdrawals + tips + leaderboardGross,
        lines,
      };
    });
  },
  ["hub-creator-cost-v5-fill-vouchers"],
  { revalidate: 60, tags: ["creator-hub"] },
);

export async function getHubCreatorCostBreakdown(
  period: DashboardPeriod,
): Promise<HubCreatorCostBreakdown> {
  return cachedHubCreatorCost(period);
}

