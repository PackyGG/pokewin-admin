import { Gift, Target } from "lucide-react";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { getDepositBonusAnalytics } from "@/lib/queries/deposit-bonus-analytics";
import { type RewardsPeriod } from "@/lib/queries/rewards-analytics";
import {
  CategoryDeepStatsPanel,
  baseDeepStatsTiles,
  type DeepStatsTile,
} from "./category-deep-stats";

/**
 * Deposit Bonus tab on /rewards/analytics. Renders the shared
 * CategoryDeepStatsPanel with the baseline tiles plus the deposit
 * bonus-specific cap-hit tile (observed cap value + how often a
 * payout equals it). The cap is derived empirically from the period
 * max — see `deposit-bonus-analytics.ts` for why.
 *
 * House-POV: deposit bonus is money the house GIVES users → rose.
 */
export async function DepositBonusTab({
  period,
  periodLabel,
}: {
  period: RewardsPeriod;
  periodLabel: string;
}) {
  const data = await getDepositBonusAnalytics(period);
  // Cap-hit tile is inserted right after Median (before Max) so the
  // "central tendency → cap behaviour → outliers" reads left-to-right.
  const base = baseDeepStatsTiles(data, periodLabel, {
    countSub: "Bonuses awarded",
  });
  const tiles: DeepStatsTile[] = [
    ...base.slice(0, 4),
    {
      label: `Cap hits (${formatCurrency(data.capValue)})`,
      value: `${(data.capHitRate * 100).toFixed(1)}%`,
      sub: `${formatNumber(data.capHits)} of ${formatNumber(data.count)} hit cap`,
      icon: Target,
    },
    ...base.slice(4),
  ];
  return (
    <CategoryDeepStatsPanel
      data={data}
      periodLabel={periodLabel}
      headerIcon={Gift}
      headerTitle="Deposit Bonus"
      tiles={tiles}
      unitLabel="bonuses"
      emptyTitle="No deposit bonuses in this window"
      emptyDescription={`No deposit bonuses were awarded in the ${periodLabel.toLowerCase()} period. Try a longer period.`}
    />
  );
}
