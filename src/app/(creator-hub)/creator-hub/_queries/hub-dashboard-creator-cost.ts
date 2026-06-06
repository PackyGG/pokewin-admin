import "server-only";

import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
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
      const db = await getDb();
      const interval = hubPeriodToInterval(period);
      const since = `NOW() - INTERVAL '${interval}'`;

      const sinceDate = hubPeriodToSinceDate(period);
      let fillConverted = 0;
      try {
        const fillSessions = await getConvertedFillSessionsInWindow(sinceDate);
        fillConverted = sumConvertedFillSessions(fillSessions);
      } catch (err) {
        console.error(
          "[creator-hub] fill converted sessions failed (cost uses tips+LB only):",
          err,
        );
      }

      type MultiplierRow = { multiplier_payouts: string };
      const multiplierRows = await db.$queryRawUnsafe<MultiplierRow[]>(
        `SELECT COALESCE(SUM(v.value::numeric), 0)::text AS multiplier_payouts
         FROM vouchers v
         WHERE v.origin::text = 'creator_multiplier_payout'
           AND v.created_at >= ${since}`,
      );
      const creatorWithdrawals =
        fillConverted + toNumber(multiplierRows[0]?.multiplier_payouts);

      type TipsRow = { tips: string };
      const tipsRows = await db.$queryRawUnsafe<TipsRow[]>(
        `SELECT COALESCE(SUM(ABS(amount::numeric)), 0)::text AS tips
         FROM ledger_transactions
         WHERE status = 'completed'
           AND type::text = 'creator_fill_spend_tip'
           AND created_at >= ${since}`,
      );
      const tips = toNumber(tipsRows[0]?.tips);

      type LeaderboardRow = { gross: string };
      const leaderboardRows = await db.$queryRawUnsafe<LeaderboardRow[]>(
        `SELECT COALESCE(SUM(ABS(amount::numeric)), 0)::text AS gross
         FROM ledger_transactions
         WHERE status = 'completed'
           AND type::text = 'affiliate_leaderboard_prize'
           AND created_at >= ${since}`,
      );
      const leaderboardGross = toNumber(leaderboardRows[0]?.gross);

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

/** @deprecated Prefer {@link getHubCreatorCostBreakdown}. */
export async function getHubCreatorCostUsd(
  period: DashboardPeriod,
): Promise<number> {
  const breakdown = await getHubCreatorCostBreakdown(period);
  return breakdown.total;
}
