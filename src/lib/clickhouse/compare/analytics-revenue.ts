import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { RevenueData } from "@/lib/queries/analytics-revenue";

import { getRevenueBreakdownFromClickHouse } from "../queries/analytics/revenue";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the /analytics → Revenue tab "Revenue by
 * source" breakdown (`getRevenueBreakdown`). No-op unless the
 * `analytics_revenue` surface is in `comparison` mode. Diffs every rendered
 * money scalar (inflow rows, gaming-payout rows, reward rows, neutral, and the
 * headline GGR/NGR + totals) within half a cent. The neutral / voucher-redeemed
 * / leaderboard-prize rows carry the documented session-window-vs-wholesale
 * scope divergence (see queries/analytics/revenue.ts). Swallows every error so
 * the served Postgres payload is never affected.
 */

const MONEY_FIELDS = [
  "wager",
  "upgraderWager",
  "shippingFees",
  "inventoryKeep",
  "battleRefund",
  "upgraderPayout",
  "bonuses",
  "rakeback",
  "affiliate",
  "rainRace",
  "signupPack",
  "waitlist",
  "voucherRedeemed",
  "leaderboardPrize",
  "cardConversions",
  "totalInflow",
  "totalGamingPayout",
  "totalRewardSpend",
  "totalNeutral",
  "ggr",
  "ngr",
] as const;

function pick(rows: { key: string; total: number }[], key: string): number {
  return rows.find((r) => r.key === key)?.total ?? 0;
}

function flattenPg(d: RevenueData): Record<string, number> {
  return {
    wager: pick(d.inflows, "wager"),
    upgraderWager: pick(d.inflows, "upgrader_wager"),
    shippingFees: pick(d.inflows, "shipping_fees"),
    inventoryKeep: pick(d.gamingOutflows, "inventory_keep"),
    battleRefund: pick(d.gamingOutflows, "battle_refund"),
    upgraderPayout: pick(d.gamingOutflows, "upgrader_payout"),
    bonuses: pick(d.rewardOutflows, "bonuses"),
    rakeback: pick(d.rewardOutflows, "rakeback"),
    affiliate: pick(d.rewardOutflows, "affiliate"),
    rainRace: pick(d.rewardOutflows, "rain_race"),
    signupPack: pick(d.rewardOutflows, "signup_pack"),
    waitlist: pick(d.rewardOutflows, "waitlist"),
    voucherRedeemed: pick(d.rewardOutflows, "voucher_redeemed"),
    leaderboardPrize: pick(d.rewardOutflows, "leaderboard_prize"),
    cardConversions: pick(d.neutral, "card_conversions"),
    totalInflow: d.totalInflow,
    totalGamingPayout: d.totalGamingPayout,
    totalRewardSpend: d.totalRewardSpend,
    totalNeutral: d.totalNeutral,
    ggr: d.ggr,
    ngr: d.ngr,
  };
}

export async function compareRevenue(pgData: RevenueData): Promise<void> {
  try {
    const mode = await getAdminReadMode("analytics_revenue");
    if (mode !== "comparison") return;

    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getRevenueBreakdownFromClickHouse(pgData.period, blacklist);
    });

    const chRecord: Record<string, number> = {
      wager: ch.wager,
      upgraderWager: ch.upgraderWager,
      shippingFees: ch.shippingFees,
      inventoryKeep: ch.inventoryKeep,
      battleRefund: ch.battleRefund,
      upgraderPayout: ch.upgraderPayout,
      bonuses: ch.bonuses,
      rakeback: ch.rakeback,
      affiliate: ch.affiliate,
      rainRace: ch.rainRace,
      signupPack: ch.signupPack,
      waitlist: ch.waitlist,
      voucherRedeemed: ch.voucherRedeemed,
      leaderboardPrize: ch.leaderboardPrize,
      cardConversions: ch.cardConversions,
      totalInflow: ch.totalInflow,
      totalGamingPayout: ch.totalGamingPayout,
      totalRewardSpend: ch.totalRewardSpend,
      totalNeutral: ch.totalNeutral,
      ggr: ch.ggr,
      ngr: ch.ngr,
    };

    const drift = computeDrift(flattenPg(pgData), chRecord, MONEY_FIELDS);
    logComparison(`analytics_revenue[${pgData.period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.analytics_revenue",
      "comparison failed (ignored)",
      err,
    );
  }
}
