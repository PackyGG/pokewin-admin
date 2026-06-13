import Link from "next/link";
import {
  Target,
  Crown,
  PieChart,
  BarChart3,
  ArrowUpRight,
  Users,
  Percent,
  Sigma,
} from "lucide-react";
import {
  SectionHeading,
  KpiTile,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  formatCurrency,
  formatDateTime,
  formatNumber,
  formatRelative,
} from "@/lib/utils/format";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { getDepositBonusCapAnalysis } from "@/lib/queries/insights-rewards/deposit-bonus/cap-analysis";
import { getDepositBonusRatioDistribution } from "@/lib/queries/insights-rewards/deposit-bonus/cohort";
import { CapAmountHistogram } from "./cap-histogram-chart";
import { RatioBucketsBars } from "./ratio-buckets-bars";

/**
 * Cap & Ratio tab — covers two of the spec's metric blocks side-by-side:
 *
 *   - Cap analysis        : empirical cap value, hit rate over time,
 *                            amount-distribution histogram (8 buckets
 *                            spanning $0 → cap), top 10 cap-hitters,
 *                            top 10 biggest deposits that triggered
 *                            the cap.
 *   - Bonus/deposit ratio : 5-bucket histogram of bonus/deposit %,
 *                            mean ratio, median ratio.
 *
 * The cap is derived empirically (`MAX(ABS(amount))`) — see the
 * deposit-bonus-analytics.ts header comment for the rationale.
 *
 * House-POV: rose for cost-side numbers, amber for the cap-rate KPI
 * (high = many users hitting the ceiling, which is a warning signal).
 */
export async function CapTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  // Each query is statement-timeout bounded (REWARD_QUERY_TIMEOUT_MS) so a
  // pathological scan degrades to its own fallback tile instead of hanging
  // the segment — both the cap-analysis biggest-cap-deposit pairing and
  // the ratio-distribution pairing are materialised hash joins (see
  // cap-analysis.ts / cohort.ts).
  const [capRes, ratioRes] = await Promise.all([
    safeQuery(
      () => getDepositBonusCapAnalysis(period),
      null,
      "insights-rewards-deposit-bonus.cap",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    // Ratio histogram only — not the full cohort comparison (with/without
    // retention split lives on the Cohorts tab). Both share the same
    // canonical pairing but are cached independently.
    safeQuery(
      () => getDepositBonusRatioDistribution(period),
      null,
      "insights-rewards-deposit-bonus.ratio",
      REWARD_QUERY_TIMEOUT_MS,
    ),
  ]);
  if (capRes.error || !capRes.data) {
    return (
      <TileErrorFallback
        label="Deposit Bonus — Cap analysis"
        hint="The cap-analysis query failed."
        size="panel"
      />
    );
  }
  const cap = capRes.data;
  const ratio = ratioRes.data;
  const label = insightsRewardsPeriodLabel(period);

  if (cap.capValue === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Target}
          title={`No bonuses in ${label.toLowerCase()}`}
          description="Cap analysis can't compute without bonus payouts in the window."
          compact
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <FadeIn>
        <CapKpiStrip cap={cap} />
      </FadeIn>

      <FadeIn>
        <div className="grid gap-4 xl:grid-cols-2">
          <div className="space-y-3">
            <SectionHeading
              icon={BarChart3}
              title={`Bonus amount distribution — to cap ${formatCurrency(cap.capValue)}`}
            />
            <div className="surface-sheen relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
              <CapAmountHistogram buckets={cap.amountDistribution} />
            </div>
          </div>
          <div className="space-y-3">
            <SectionHeading
              icon={PieChart}
              title="Bonus / deposit ratio distribution"
            />
            <div className="surface-sheen relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
              {ratio && ratio.totalDeposits > 0 ? (
                <>
                  <RatioBucketsBars buckets={ratio.ratioBuckets} />
                  <div className="mt-4 grid grid-cols-2 gap-2 text-center">
                    <div className="rounded-lg border bg-muted/20 p-2.5">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Mean ratio
                      </p>
                      <p className="mt-0.5 text-base font-bold tabular-nums text-rose-600 dark:text-rose-400">
                        {(ratio.meanRatio * 100).toFixed(1)}%
                      </p>
                    </div>
                    <div className="rounded-lg border bg-muted/20 p-2.5">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Median ratio
                      </p>
                      <p className="mt-0.5 text-base font-bold tabular-nums text-rose-600 dark:text-rose-400">
                        {(ratio.medianRatio * 100).toFixed(1)}%
                      </p>
                    </div>
                  </div>
                </>
              ) : (
                <EmptyState
                  icon={PieChart}
                  title="No paired deposits"
                  description="No bonus↔deposit pairings in window."
                  compact
                />
              )}
            </div>
          </div>
        </div>
      </FadeIn>

      <FadeIn>
        <div className="grid gap-4 xl:grid-cols-2">
          <div className="space-y-3">
            <SectionHeading icon={Crown} title="Top cap hitters (by count)" />
            <div className="surface-sheen relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
              {cap.topCapHitters.length > 0 ? (
                <TopCapHittersTable rows={cap.topCapHitters} />
              ) : (
                <EmptyState
                  icon={Crown}
                  title="No cap hitters"
                  description="No users hit the cap in this window."
                  compact
                />
              )}
            </div>
          </div>
          <div className="space-y-3">
            <SectionHeading
              icon={ArrowUpRight}
              title={`Biggest cap deposits (${formatCurrency(cap.capValue)} bonus)`}
            />
            <div className="surface-sheen relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
              {cap.biggestCapDeposits.length > 0 ? (
                <BiggestCapDepositsTable rows={cap.biggestCapDeposits} />
              ) : (
                <EmptyState
                  icon={ArrowUpRight}
                  title="No cap-paired deposits"
                  description="No deposits triggered a cap-equal bonus in window."
                  compact
                />
              )}
            </div>
          </div>
        </div>
      </FadeIn>
    </div>
  );
}

function CapKpiStrip({
  cap,
}: {
  cap: NonNullable<Awaited<ReturnType<typeof getDepositBonusCapAnalysis>>>;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <KpiTile
        label="Empirical cap"
        value={formatCurrency(cap.capValue)}
        sub="MAX(ABS(amount)) in window"
        icon={Target}
        accent="amber"
      />
      <KpiTile
        label="Cap hits"
        value={formatNumber(cap.capHits)}
        sub="rows at cap value"
        icon={Sigma}
        accent="rose"
      />
      <KpiTile
        label="Hit rate"
        value={`${(cap.capHitRate * 100).toFixed(1)}%`}
        sub="of all bonuses"
        icon={Percent}
        accent="amber"
      />
      <KpiTile
        label="Unique hitters"
        value={formatNumber(cap.uniqueCapHitters)}
        sub="distinct users"
        icon={Users}
        accent="blue"
      />
      <KpiTile
        label="Avg hits/hitter"
        value={
          cap.uniqueCapHitters > 0
            ? (cap.capHits / cap.uniqueCapHitters).toFixed(1)
            : "—"
        }
        sub="cap hits per distinct user"
        icon={Crown}
        accent="amber"
      />
    </div>
  );
}

function TopCapHittersTable({
  rows,
}: {
  rows: Array<{
    userId: string;
    username: string | null;
    capHits: number;
    totalBonus: number;
    lastHitAt: string;
  }>;
}) {
  return (
    <>
      {/* Mobile cards (<md) */}
      <div className="space-y-1.5 md:hidden">
        {rows.map((r, i) => (
          <div
            key={r.userId}
            className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5"
          >
            <span className="w-6 shrink-0 text-xs tabular-nums text-muted-foreground">
              #{i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <Link
                href={`/users/${r.userId}`}
                className="block truncate text-sm font-medium hover:underline"
              >
                {r.username ?? r.userId.slice(0, 8)}
              </Link>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {r.capHits} cap hits · {formatRelative(r.lastHitAt)}
              </span>
            </div>
            <span className="shrink-0 text-sm font-medium tabular-nums text-rose-600 dark:text-rose-400">
              {formatCurrency(r.totalBonus)}
            </span>
          </div>
        ))}
      </div>
      {/* Desktop table */}
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[50px]">Rank</TableHead>
              <TableHead>User</TableHead>
              <TableHead className="text-right">Cap hits</TableHead>
              <TableHead className="text-right">Total bonus</TableHead>
              <TableHead>Last hit</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={r.userId}>
                <TableCell className="tabular-nums text-muted-foreground">
                  #{i + 1}
                </TableCell>
                <TableCell className="font-medium">
                  <Link href={`/users/${r.userId}`} className="hover:underline">
                    {r.username ?? r.userId.slice(0, 8)}
                  </Link>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatNumber(r.capHits)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                  {formatCurrency(r.totalBonus)}
                </TableCell>
                <TableCell className="tabular-nums text-muted-foreground">
                  {formatRelative(r.lastHitAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

function BiggestCapDepositsTable({
  rows,
}: {
  rows: Array<{
    userId: string;
    username: string | null;
    depositUsd: number;
    bonusUsd: number;
    createdAt: string;
  }>;
}) {
  return (
    <>
      {/* Mobile cards */}
      <div className="space-y-1.5 md:hidden">
        {rows.map((r) => (
          <div
            key={`${r.userId}-${r.createdAt}`}
            className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5"
          >
            <div className="min-w-0 flex-1">
              <Link
                href={`/users/${r.userId}`}
                className="block truncate text-sm font-medium hover:underline"
              >
                {r.username ?? r.userId.slice(0, 8)}
              </Link>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {formatDateTime(r.createdAt)}
              </span>
            </div>
            <div className="shrink-0 text-right">
              <p className="text-sm font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
                {formatCurrency(r.depositUsd)}
              </p>
              <p className="text-[10px] tabular-nums text-rose-600 dark:text-rose-400">
                +{formatCurrency(r.bonusUsd)}
              </p>
            </div>
          </div>
        ))}
      </div>
      {/* Desktop table */}
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
            {rows.map((r) => (
              <TableRow key={`${r.userId}-${r.createdAt}`}>
                <TableCell className="font-medium">
                  <Link href={`/users/${r.userId}`} className="hover:underline">
                    {r.username ?? r.userId.slice(0, 8)}
                  </Link>
                </TableCell>
                <TableCell className="tabular-nums text-muted-foreground">
                  {formatDateTime(r.createdAt)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                  {formatCurrency(r.depositUsd)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                  <ArrowUpRight className="mr-1 inline size-3.5" />
                  {formatCurrency(r.bonusUsd)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
