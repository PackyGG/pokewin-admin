import { Suspense } from "react";
import { Gift, Target } from "lucide-react";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { getDepositBonusAnalytics } from "@/lib/queries/deposit-bonus-analytics";
import { type RewardsPeriod } from "@/lib/queries/rewards-analytics";
import {
  CategoryDeepStatsPanel,
  baseDeepStatsTiles,
  type DeepStatsTile,
} from "./category-deep-stats";
import { DepositBonusCohortSection } from "./deposit-bonus-cohort-section";
import { DepositBonusCohortSkeleton } from "./tab-skeleton";

/**
 * Deposit Bonus tab on /rewards/analytics. Renders the shared
 * CategoryDeepStatsPanel with baseline + cap-hit tiles, then defers
 * the cohort comparison + ratio histogram + top cap-hit deposits to
 * a Suspense-wrapped child so the headline KPIs + chart + top-N
 * tables paint first.
 *
 * Why split:
 *   `getDepositBonusCohortExtras` runs three CTE blocks against
 *   `ledger_transactions` pairing bonus rows to deposits via
 *   `balance_before = balance_after`. With no covering index on the
 *   bonus side it was the slowest query on the tab for 30d+ windows
 *   — moving it behind its own Suspense stops first paint waiting on
 *   it. See `deposit-bonus-cohort-section.tsx` for the lazy half.
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
  // Cap-hit tile sits right after Median (before Max) so the strip
  // reads "central tendency → cap behaviour → outliers" left-to-right.
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
    <div className="space-y-6">
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

      {/* Cohort + distribution + top-cap deposits — Suspense-wrapped
          because the cohort SQL is the slow query on the tab.
          Keyed on `period` so flipping windows shows the skeleton
          instead of stale numbers from the previous period. */}
      <Suspense key={period} fallback={<DepositBonusCohortSkeleton />}>
        <DepositBonusCohortSection
          period={period}
          capValue={data.capValue}
          count={data.count}
        />
      </Suspense>
    </div>
  );
}
