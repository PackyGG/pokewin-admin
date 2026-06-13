import Link from "next/link";
import {
  Users,
  PieChart,
  ArrowUpRight,
  Crown,
  Gift,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { SectionHeading, KpiTile } from "@/components/modern-panels";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { EmptyState } from "@/components/empty-state";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { formatCurrency, formatDateTime, formatNumber } from "@/lib/utils/format";
import { getDepositBonusCohortExtras } from "@/lib/queries/deposit-bonus-analytics";
import {
  safeQueryOrNull,
  REWARD_QUERY_TIMEOUT_MS,
} from "@/lib/errors/safe-query";
import { type RewardsPeriod } from "@/lib/queries/rewards-analytics";
import { CohortCompareCard } from "./cohort-compare";
import { DistributionBarChart } from "./distribution-bar-chart";

/**
 * Cohort + distribution + top-cap-deposits section of the Deposit
 * Bonus tab on /rewards/analytics. Lives in its own server component
 * so the parent tab can wrap it in a Suspense boundary — the headline
 * KPI strip + daily-volume chart + top-users/days tables paint first,
 * and this slower section streams in behind a skeleton.
 *
 * Why split:
 *   `getDepositBonusCohortExtras` runs three CTE blocks against
 *   `ledger_transactions` with bonus-to-deposit pairing on
 *   `balance_before = balance_after`. The bonus side has no covering
 *   index on those columns, so this is the slowest query on the tab
 *   even after the hash-join rewrite (~1.3s on prod). Lazy-loading lets
 *   the page paint while the cohort numbers resolve in the background.
 *
 * Resilience: the query is run through `safeQueryOrNull` with a
 * statement timeout, so if it ever degrades again on a larger prod
 * dataset it falls back to a single TileErrorFallback tile INSTEAD of
 * throwing into the page-level /insights error boundary (which would
 * take down the whole Rewards Insights page — that 57014 timeout was
 * the original bug this section caused). The rest of the Deposit Bonus
 * tab and the other category panels keep rendering.
 *
 * House-POV: same as the parent tab — every amount is house-cost rose.
 */
export async function DepositBonusCohortSection({
  period,
  capValue,
  count,
}: {
  /** Selected rewards window. */
  period: RewardsPeriod;
  /** Empirical cap value from the baseline; gates top-cap-deposits filter. */
  capValue: number;
  /** Baseline count — skip rendering entirely when there were no bonuses. */
  count: number;
}) {
  if (count === 0) return null;
  const { data: cohort } = await safeQueryOrNull(
    () => getDepositBonusCohortExtras(period, capValue),
    "rewards.deposit-bonus.cohort",
    REWARD_QUERY_TIMEOUT_MS,
  );
  if (!cohort) {
    return (
      <TileErrorFallback
        label="Deposit bonus cohort"
        hint="The cohort breakdown is taking too long — refresh to retry."
        size="panel"
      />
    );
  }

  // Cohort tiles appended to a small strip on top of this section so
  // the lazy-loaded numbers still get prominent placement once they
  // resolve, without crowding the headline strip above.
  const cohortTiles = [
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
      {/* Mini KPI strip for cohort-only numbers — sits at the top of
          this section so when it streams in the user immediately sees
          the cohort headline percentages. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-2">
        {cohortTiles.map((tile) => (
          <KpiTile
            key={tile.label}
            label={tile.label}
            value={tile.value}
            sub={tile.sub}
            icon={tile.icon}
            accent="rose"
          />
        ))}
      </div>

      {cohort.totalDeposits > 0 && (
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
            <DistributionBarChart data={cohort.ratioBuckets} metric="count" />
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

      {cohort.topCapDeposits.length > 0 && (
        <div className="space-y-3">
          <SectionHeading
            icon={Crown}
            title={`Top deposits that hit the ${formatCurrency(capValue)} cap`}
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

      {/* Defensive empty-state — the parent gates on `count > 0`, so
          this only triggers when bonuses were awarded but no matching
          completed deposits were found in the period (highly unusual;
          typically bonus-only adjustments). */}
      {cohort.totalDeposits === 0 && (
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
