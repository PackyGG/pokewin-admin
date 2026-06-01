import { Share2, Users, Sigma } from "lucide-react";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { getAffiliateAnalytics } from "@/lib/queries/rewards-category-analytics";
import { getAffiliateExtras } from "@/lib/queries/rewards-category-extras";
import { type RewardsPeriod } from "@/lib/queries/rewards-analytics";
import {
  CategoryDeepStatsPanel,
  baseDeepStatsTiles,
  type DeepStatsTile,
} from "./category-deep-stats";

/**
 * Affiliate tab on /rewards/analytics. Surfaces the baseline strip
 * (total / count / avg / median / max / unique recipients) plus the
 * affiliate-account lens:
 *
 *   - Distinct affiliate accounts paid in the window
 *   - Avg payout per affiliate (total volume / distinct affiliates)
 *
 * Because `affiliate_claim` ledger rows file under the AFFILIATE's
 * user_id, the shared baseline's "Top 10 users by volume" IS the top
 * 10 affiliates by claim volume — no second leaderboard needed. The
 * top-users leaderboard's "unique recipients" tile (in the baseline)
 * equals the distinct-affiliate count, so we relabel the extras tile
 * to make the lens explicit.
 *
 * PROPOSED (skipped this pass):
 *   - Per-affiliate count of distinct referred users contributing in
 *     the period. Would need joining `affiliate_code_usages` on
 *     `affiliate_user_id` per top affiliate with a window filter —
 *     heavy enough that it doesn't belong in the cached headline
 *     payload. Could ship as a popover later.
 *
 * House-POV: affiliate commissions are money the house GIVES users
 * (the affiliate) → rose.
 */
export async function AffiliateTab({
  period,
  periodLabel,
}: {
  period: RewardsPeriod;
  periodLabel: string;
}) {
  const [data, extras] = await Promise.all([
    getAffiliateAnalytics(period),
    getAffiliateExtras(period),
  ]);
  const base = baseDeepStatsTiles(data, periodLabel, {
    countSub: "Claims paid",
    avgPerUserSub: "avg per affiliate",
  });
  const extraTiles: DeepStatsTile[] = [
    {
      label: "Distinct affiliates",
      value: formatNumber(extras.distinctAffiliates),
      sub: "Paid in this window",
      icon: Users,
    },
    {
      label: "Avg per affiliate",
      value: formatCurrency(extras.avgPayoutPerAffiliate),
      sub: "Total / distinct affiliates",
      icon: Sigma,
    },
  ];
  const tiles: DeepStatsTile[] = [...extraTiles, ...base];
  return (
    <CategoryDeepStatsPanel
      data={data}
      periodLabel={periodLabel}
      headerIcon={Share2}
      headerTitle="Affiliate"
      tiles={tiles}
      unitLabel="claims"
      emptyTitle="No affiliate claims in this window"
      emptyDescription={`No affiliates were paid in the ${periodLabel.toLowerCase()} period. Try a longer period.`}
    />
  );
}
