import Link from "next/link";
import {
  Gift,
  Target,
  Sparkles,
  TrendingUp,
  Users,
  PieChart,
  ArrowUpRight,
  Crown,
} from "lucide-react";
import { SectionHeading } from "@/components/modern-panels";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { EmptyState } from "@/components/empty-state";
import { formatCurrency, formatDateTime, formatNumber } from "@/lib/utils/format";
import {
  getDepositBonusAnalytics,
  getDepositBonusCohortExtras,
} from "@/lib/queries/deposit-bonus-analytics";
import { type RewardsPeriod } from "@/lib/queries/rewards-analytics";
import {
  CategoryDeepStatsPanel,
  baseDeepStatsTiles,
  type DeepStatsTile,
} from "./category-deep-stats";
import { CohortCompareCard } from "./cohort-compare";
import { DistributionBarChart } from "./distribution-bar-chart";

/**
 * Deposit Bonus tab on /rewards/analytics. Renders the shared
 * CategoryDeepStatsPanel with baseline + cap-hit tiles, then layers
 * three deeper sections:
 *
 *   1. Cohort comparison — deposits WITH bonus vs deposits WITHOUT
 *      bonus (count split + share + avg deposit size + lift%). Uses
 *      the canonical bonus↔deposit pairing rule (bal_before ==
 *      bal_after, within 2 minutes) from dashboard-live.ts so the
 *      pairing reconciles with the live money-movement feed.
 *   2. Bonus-to-deposit ratio histogram — how much of each deposit
 *      typically returns as bonus. Buckets: 0–5 / 5–15 / 15–30 /
 *      30–60 / 60%+.
 *   3. Top cap-hit deposits — five largest deposits in the window
 *      whose paired bonus equalled the cap. Surfaces "who is reliably
 *      hitting the cap".
 *
 * House-POV: deposit bonus is money the house GIVES users → rose.
 * Cohort-card values are deposit amounts (neutral magnitude, not rose
 * by themselves), but the lift% pill flips rose when claimants
 * deposit MORE (i.e. drives more downstream rose-cost).
 */
export async function DepositBonusTab({
  period,
  periodLabel,
}: {
  period: RewardsPeriod;
  periodLabel: string;
}) {
  const data = await getDepositBonusAnalytics(period);
  // Cohort extras run in parallel — they need the cap value from the
  // baseline to filter the top cap-hit deposits, but cap is just the
  // observed max so we pass it directly. Two separate caches lets the
  // baseline + cohort revalidate independently.
  const cohort = await getDepositBonusCohortExtras(period, data.capValue);
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
    // Cohort lens tiles appended at the end — they share the strip
    // with baseline + cap so a single glance shows "what was paid, at
    // what cap rate, by how many deposits".
    {
      label: "Deposits with bonus",
      value: `${(cohort.shareWith * 100).toFixed(1)}%`,
      sub: `${formatNumber(cohort.depositsWith)} of ${formatNumber(cohort.totalDeposits)} deposits`,
      icon: Sparkles,
    },
    {
      label: "First-time claimants",
      value: `${(cohort.shareFirstTime * 100).toFixed(1)}%`,
      sub: `${formatNumber(cohort.firstTimeClaimants)} new · ${formatNumber(cohort.repeatClaimants)} repeat`,
      icon: TrendingUp,
    },
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

      {/* Cohort comparison + ratio histogram only render when the
          period actually contains paired data. Empty windows already
          surface the panel's empty state above; rendering this
          section against zero data is noise. */}
      {data.count > 0 && cohort.totalDeposits > 0 && (
        <div className="space-y-3">
          <SectionHeading icon={Users} title="With bonus vs without" />
          <CohortCompareCard
            title="Average deposit size"
            subtitle="Bonus claimants vs non-claimants in the period"
            leftLabel="With bonus"
            leftValue={formatCurrency(cohort.avgDepositWith)}
            leftSub={`${formatNumber(cohort.depositsWith)} deposits`}
            rightLabel="Without bonus"
            rightValue={formatCurrency(cohort.avgDepositWithout)}
            rightSub={`${formatNumber(cohort.depositsWithout)} deposits`}
            liftPct={cohort.liftPct}
          />
        </div>
      )}

      {data.count > 0 && (
        <div className="space-y-3">
          <SectionHeading
            icon={PieChart}
            title="Bonus / deposit ratio distribution"
          />
          <div className="surface-sheen relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
            <p className="text-[11px] text-muted-foreground">
              How much of each deposit returns as bonus, bucketed.
            </p>
            <div className="mt-3">
              <DistributionBarChart
                data={cohort.ratioBuckets}
                metric="count"
              />
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
              {cohort.ratioBuckets.map((b) => (
                <div
                  key={b.label}
                  className="rounded-lg border bg-muted/20 p-2.5"
                >
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {b.label}
                  </p>
                  <p className="mt-0.5 text-sm font-bold tabular-nums">
                    {formatNumber(b.count)}
                  </p>
                  <p className="text-[10px] tabular-nums text-rose-600 dark:text-rose-400">
                    {formatCurrency(b.volume)}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {data.count > 0 && cohort.topCapDeposits.length > 0 && (
        <div className="space-y-3">
          <SectionHeading
            icon={Crown}
            title={`Top deposits that hit the ${formatCurrency(data.capValue)} cap`}
          />
          <div className="surface-sheen relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
            {/* Mobile cards (<md) */}
            <div className="space-y-1.5 md:hidden">
              {cohort.topCapDeposits.map((d) => (
                <div
                  key={`${d.userId}-${d.createdAt}`}
                  className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/users/${d.userId}`}
                      className="block truncate text-sm font-medium hover:underline"
                    >
                      {d.username ?? d.userId.slice(0, 8)}
                    </Link>
                    <span className="text-[11px] tabular-nums text-muted-foreground">
                      {formatDateTime(d.createdAt)}
                    </span>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-sm font-medium tabular-nums">
                      {formatCurrency(d.depositUsd)}
                    </p>
                    <p className="text-[10px] tabular-nums text-rose-600 dark:text-rose-400">
                      +{formatCurrency(d.bonusUsd)} bonus
                    </p>
                  </div>
                </div>
              ))}
            </div>
            {/* Desktop table (>=md) */}
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead>When</TableHead>
                    <TableHead className="text-right">Deposit</TableHead>
                    <TableHead className="text-right">Bonus</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {cohort.topCapDeposits.map((d) => (
                    <TableRow key={`${d.userId}-${d.createdAt}`}>
                      <TableCell className="font-medium">
                        <Link
                          href={`/users/${d.userId}`}
                          className="hover:underline"
                        >
                          {d.username ?? d.userId.slice(0, 8)}
                        </Link>
                      </TableCell>
                      <TableCell className="tabular-nums text-muted-foreground">
                        {formatDateTime(d.createdAt)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrency(d.depositUsd)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                        <ArrowUpRight className="mr-1 inline size-3.5" />
                        {formatCurrency(d.bonusUsd)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        </div>
      )}

      {/* Defensive empty-state if cohort returned zero deposits — the
          baseline already showed `count > 0`, so this only triggers
          when the period contains bonuses but no completed deposits
          (highly unusual; mostly bonus-only adjustments). */}
      {data.count > 0 && cohort.totalDeposits === 0 && (
        <div className="rounded-2xl border bg-card p-4">
          <EmptyState
            icon={Gift}
            title="No paired deposits in this window"
            description="Deposit bonuses were awarded but no matching completed deposits were found in the period — cohort cards skipped."
            compact
          />
        </div>
      )}
    </div>
  );
}
