import {
  Users,
  Sparkles,
  Repeat,
  Clock,
  Activity,
  TrendingUp,
  TrendingDown,
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
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { cn } from "@/lib/utils";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import {
  getDepositBonusCohortComparison,
  type DepositBonusCohortComparison,
} from "@/lib/queries/insights-rewards/deposit-bonus/cohort";
import {
  getDepositBonusRepeatClaimants,
  getDepositBonusNewVsReturning,
  getDepositBonusTimeToClaim,
  type DepositBonusRepeatClaimants,
  type DepositBonusNewVsReturning,
  type DepositBonusTimeToClaim,
} from "@/lib/queries/insights-rewards/deposit-bonus/behavior";
import {
  compareDepositBonusCohortComparison,
  compareDepositBonusNewVsReturning,
  compareDepositBonusRepeatClaimants,
  compareDepositBonusTimeToClaim,
} from "@/lib/clickhouse/compare/deposit-bonus-cohorts";
import { getDepositBonusCohortComparisonFromClickHouse } from "@/lib/clickhouse/queries/insights-rewards/deposit-bonus/cohort";
import { getDepositBonusNewVsReturningFromClickHouse } from "@/lib/clickhouse/queries/insights-rewards/deposit-bonus/new-vs-returning";
import { getDepositBonusRepeatClaimantsFromClickHouse } from "@/lib/clickhouse/queries/insights-rewards/deposit-bonus/repeat-claimants";
import { getDepositBonusTimeToClaimFromClickHouse } from "@/lib/clickhouse/queries/insights-rewards/deposit-bonus/time-to-claim";
import { resolveAdminRead } from "@/lib/clickhouse/resolve-read";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { CohortCompareCard } from "@/app/(admin)/rewards/analytics/_components/cohort-compare";

/**
 * Cohorts tab — three cohort lenses + time-to-claim latency.
 *
 *   1. With-bonus vs without-bonus deposits — count, avg, median, p99,
 *      retain7d/retain30d, avg/median/retention lift %.
 *   2. New vs returning claimants — users, avg first deposit, retention,
 *      second-deposit rate within 30d.
 *   3. Repeat claimant segmentation — 1 claim, 2–5, 6–20, 21+ — count,
 *      avg bonus per user, wager in window (proxy LTV).
 *   4. Time-to-claim — distribution + median / p95 / p99 latency.
 *
 * House-POV: bonuses are house cost → rose. Lift % reads rose-positive
 * when claimants behave better (= cost was worth it from a behaviour
 * lens), neutral otherwise.
 */
export async function CohortsTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  // Each query is statement-timeout bounded (REWARD_QUERY_TIMEOUT_MS) so a
  // pathological scan degrades to its own fallback tile instead of hanging
  // the segment — the cohort + time-to-claim pairings are the heaviest
  // queries on this surface (materialised hash joins; see cohort.ts /
  // behavior.ts).
  const [cohortRes, newRetRes, repeatRes, ttcRes] = await Promise.all([
    safeQuery(
      () =>
        resolveAdminRead<DepositBonusCohortComparison>(
          "insights_deposit_bonus_cohort",
          {
            pg: () => getDepositBonusCohortComparison(period),
            ch: async () =>
              getDepositBonusCohortComparisonFromClickHouse(
                period,
                await getExcludedUserIds(),
              ),
            compare: (pg) =>
              void compareDepositBonusCohortComparison(period, pg),
          },
        ),
      null,
      "insights-rewards-deposit-bonus.cohort",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () =>
        resolveAdminRead<DepositBonusNewVsReturning>(
          "insights_deposit_bonus_new_vs_returning",
          {
            pg: () => getDepositBonusNewVsReturning(period),
            ch: async () =>
              getDepositBonusNewVsReturningFromClickHouse(
                period,
                await getExcludedUserIds(),
              ),
            compare: (pg) =>
              void compareDepositBonusNewVsReturning(period, pg),
          },
        ),
      null,
      "insights-rewards-deposit-bonus.new-vs-returning",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () =>
        resolveAdminRead<DepositBonusRepeatClaimants>(
          "insights_deposit_bonus_repeat_claimants",
          {
            pg: () => getDepositBonusRepeatClaimants(period),
            ch: async () =>
              getDepositBonusRepeatClaimantsFromClickHouse(
                period,
                await getExcludedUserIds(),
              ),
            compare: (pg) =>
              void compareDepositBonusRepeatClaimants(period, pg),
          },
        ),
      null,
      "insights-rewards-deposit-bonus.repeat",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () =>
        resolveAdminRead<DepositBonusTimeToClaim>(
          "insights_deposit_bonus_time_to_claim",
          {
            pg: () => getDepositBonusTimeToClaim(period),
            ch: async () =>
              getDepositBonusTimeToClaimFromClickHouse(
                period,
                await getExcludedUserIds(),
              ),
            compare: (pg) => void compareDepositBonusTimeToClaim(period, pg),
          },
        ),
      null,
      "insights-rewards-deposit-bonus.ttc",
      REWARD_QUERY_TIMEOUT_MS,
    ),
  ]);

  const cohort = cohortRes.data;
  const newRet = newRetRes.data;
  const repeat = repeatRes.data;
  const ttc = ttcRes.data;
  const label = insightsRewardsPeriodLabel(period);

  // Whole tab depends on at least cohort data being available.
  if (cohortRes.error || !cohort) {
    return (
      <TileErrorFallback
        label="Deposit Bonus — Cohorts"
        hint="The cohort comparison query failed."
        size="panel"
      />
    );
  }

  if (cohort.totalDeposits === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Users}
          title={`No deposits in ${label.toLowerCase()}`}
          description="No completed deposits in window — cohort comparison can't be computed."
          compact
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* — Section 1: With vs Without bonus — */}
      <FadeIn>
        <div className="space-y-3">
          <SectionHeading
            icon={Users}
            title="With bonus vs without — deposit cohort"
          />
          <div className="grid gap-4 xl:grid-cols-2">
            <CohortCompareCard
              title="Average deposit size"
              subtitle="Bonus claimants vs non-claimants"
              leftLabel="With bonus"
              leftValue={formatCurrency(cohort.withBonus.avg)}
              leftSub={`${formatNumber(cohort.withBonus.count)} deposits`}
              rightLabel="Without bonus"
              rightValue={formatCurrency(cohort.withoutBonus.avg)}
              rightSub={`${formatNumber(cohort.withoutBonus.count)} deposits`}
              liftPct={cohort.avgLiftPct}
            />
            <CohortCompareCard
              title="Median deposit size"
              subtitle="Skew-robust comparison"
              leftLabel="With bonus"
              leftValue={formatCurrency(cohort.withBonus.median)}
              leftSub={`p99 ${formatCurrency(cohort.withBonus.p99)}`}
              rightLabel="Without bonus"
              rightValue={formatCurrency(cohort.withoutBonus.median)}
              rightSub={`p99 ${formatCurrency(cohort.withoutBonus.p99)}`}
              liftPct={cohort.medianLiftPct}
            />
            <CohortCompareCard
              title="7-day retention"
              subtitle="Wagered again within 7 days of deposit"
              leftLabel="With bonus"
              leftValue={`${(cohort.withBonus.retain7d * 100).toFixed(1)}%`}
              leftSub={`${formatNumber(cohort.withBonus.uniqueUsers)} unique users`}
              rightLabel="Without bonus"
              rightValue={`${(cohort.withoutBonus.retain7d * 100).toFixed(1)}%`}
              rightSub={`${formatNumber(cohort.withoutBonus.uniqueUsers)} unique users`}
              liftPct={cohort.retain7dLiftPct}
            />
            <CohortCompareCard
              title="30-day retention"
              subtitle="Wagered again within 30 days"
              leftLabel="With bonus"
              leftValue={`${(cohort.withBonus.retain30d * 100).toFixed(1)}%`}
              rightLabel="Without bonus"
              rightValue={`${(cohort.withoutBonus.retain30d * 100).toFixed(1)}%`}
              liftPct={cohort.retain30dLiftPct}
            />
          </div>
        </div>
      </FadeIn>

      {/* — Section 2: New vs Returning — */}
      {newRet && (
        <FadeIn>
          <div className="space-y-3">
            <SectionHeading
              icon={Sparkles}
              title="New vs returning claimants"
            />
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <KpiTile
                label="New claimants"
                value={formatNumber(newRet.newClaimants.users)}
                sub={`${formatCurrency(newRet.newClaimants.totalBonus)} bonus`}
                icon={Sparkles}
                accent="blue"
              />
              <KpiTile
                label="Returning claimants"
                value={formatNumber(newRet.returningClaimants.users)}
                sub={`${formatCurrency(newRet.returningClaimants.totalBonus)} bonus`}
                icon={Repeat}
                accent="rose"
              />
              <KpiTile
                label="New 7d retain"
                value={`${(newRet.newClaimants.retain7d * 100).toFixed(1)}%`}
                sub={`${(newRet.returningClaimants.retain7d * 100).toFixed(1)}% returning`}
                icon={Activity}
                accent="rose"
              />
              <KpiTile
                label="New 2nd deposit (30d)"
                value={`${(newRet.newClaimants.secondDeposit30dRate * 100).toFixed(1)}%`}
                sub={`${(newRet.returningClaimants.secondDeposit30dRate * 100).toFixed(1)}% returning`}
                icon={TrendingUp}
                accent="rose"
              />
            </div>

            <div className="surface-sheen relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
              <NewVsReturningTable data={newRet} />
            </div>
          </div>
        </FadeIn>
      )}

      {/* — Section 3: Repeat-claimant segmentation — */}
      {repeat && repeat.totalClaimants > 0 && (
        <FadeIn>
          <div className="space-y-3">
            <SectionHeading
              icon={Repeat}
              title={`Repeat-claimant segments — ${formatNumber(repeat.totalClaimants)} total claimants`}
            />
            <div className="surface-sheen relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
              <RepeatSegmentsTable
                segments={repeat.segments}
                totalBonus={repeat.totalBonus}
              />
            </div>
          </div>
        </FadeIn>
      )}

      {/* — Section 4: Time-to-claim — */}
      {ttc && ttc.totalPaired > 0 && (
        <FadeIn>
          <div className="space-y-3">
            <SectionHeading
              icon={Clock}
              title="Time-to-claim — deposit → bonus latency"
            />
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <KpiTile
                label="Paired"
                value={formatNumber(ttc.totalPaired)}
                sub="bonuses in window"
                icon={Clock}
                accent="blue"
              />
              <KpiTile
                label="Median latency"
                value={`${ttc.medianSeconds.toFixed(2)}s`}
                sub="typical bonus fire delay"
                icon={Clock}
                accent="emerald"
              />
              <KpiTile
                label="P95 latency"
                value={`${ttc.p95Seconds.toFixed(2)}s`}
                sub="95% fire within"
                icon={Clock}
                accent="amber"
              />
              <KpiTile
                label="P99 latency"
                value={`${ttc.p99Seconds.toFixed(2)}s`}
                sub="99% fire within"
                icon={Clock}
                accent="amber"
              />
              <KpiTile
                label="Max latency"
                value={`${ttc.maxSeconds.toFixed(2)}s`}
                sub="bounded by 30s join window"
                icon={Clock}
                accent="rose"
              />
            </div>

            <div className="surface-sheen relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
              <TimeToClaimBuckets buckets={ttc.buckets} total={ttc.totalPaired} />
            </div>
          </div>
        </FadeIn>
      )}
    </div>
  );
}

// ─── Tables ────────────────────────────────────────────────────────

function NewVsReturningTable({
  data,
}: {
  data: NonNullable<Awaited<ReturnType<typeof getDepositBonusNewVsReturning>>>;
}) {
  const rows: Array<{
    cohort: string;
    icon: typeof Sparkles;
    users: number;
    totalBonus: number;
    avgBonusPerUser: number;
    avgFirstDepositUsd: number;
    retain7d: number;
    secondDeposit30dRate: number;
  }> = [
    {
      cohort: "New (first time)",
      icon: Sparkles,
      users: data.newClaimants.users,
      totalBonus: data.newClaimants.totalBonus,
      avgBonusPerUser: data.newClaimants.avgBonusPerUser,
      avgFirstDepositUsd: data.newClaimants.avgFirstDepositUsd,
      retain7d: data.newClaimants.retain7d,
      secondDeposit30dRate: data.newClaimants.secondDeposit30dRate,
    },
    {
      cohort: "Returning",
      icon: Repeat,
      users: data.returningClaimants.users,
      totalBonus: data.returningClaimants.totalBonus,
      avgBonusPerUser: data.returningClaimants.avgBonusPerUser,
      avgFirstDepositUsd: data.returningClaimants.avgFirstDepositUsd,
      retain7d: data.returningClaimants.retain7d,
      secondDeposit30dRate: data.returningClaimants.secondDeposit30dRate,
    },
  ];
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Cohort</TableHead>
          <TableHead className="text-right">Users</TableHead>
          <TableHead className="text-right">Total bonus</TableHead>
          <TableHead className="text-right">Avg / user</TableHead>
          <TableHead className="text-right">Avg first deposit</TableHead>
          <TableHead className="text-right">7d retain</TableHead>
          <TableHead className="text-right">2nd deposit (30d)</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => {
          const Icon = r.icon;
          return (
            <TableRow key={r.cohort}>
              <TableCell className="font-medium">
                <div className="flex items-center gap-2">
                  <Icon className="size-3.5 text-rose-500" />
                  {r.cohort}
                </div>
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatNumber(r.users)}
              </TableCell>
              <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                {formatCurrency(r.totalBonus)}
              </TableCell>
              <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                {formatCurrency(r.avgBonusPerUser)}
              </TableCell>
              <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                {formatCurrency(r.avgFirstDepositUsd)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {(r.retain7d * 100).toFixed(1)}%
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {(r.secondDeposit30dRate * 100).toFixed(1)}%
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function RepeatSegmentsTable({
  segments,
  totalBonus,
}: {
  segments: Array<{
    label: string;
    users: number;
    totalBonus: number;
    avgBonusPerUser: number;
    wagerInWindow: number;
  }>;
  totalBonus: number;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Segment</TableHead>
          <TableHead className="text-right">Users</TableHead>
          <TableHead className="text-right">Total bonus</TableHead>
          <TableHead className="text-right">Avg / user</TableHead>
          <TableHead className="text-right">Wager in window</TableHead>
          <TableHead className="text-right">Share of cost</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {segments.map((s) => {
          const sharePct = totalBonus > 0 ? (s.totalBonus / totalBonus) * 100 : 0;
          return (
            <TableRow key={s.label}>
              <TableCell className="font-medium">{s.label}</TableCell>
              <TableCell className="text-right tabular-nums">
                {formatNumber(s.users)}
              </TableCell>
              <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                {formatCurrency(s.totalBonus)}
              </TableCell>
              <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                {formatCurrency(s.avgBonusPerUser)}
              </TableCell>
              <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                {formatCurrency(s.wagerInWindow)}
              </TableCell>
              <TableCell className="text-right tabular-nums text-muted-foreground">
                {sharePct.toFixed(1)}%
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function TimeToClaimBuckets({
  buckets,
  total,
}: {
  buckets: Array<{ label: string; count: number }>;
  total: number;
}) {
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-muted-foreground">
        Distribution of seconds between a deposit and its bonus ledger
        write. Outliers in the 30s+ bucket indicate backend write lag.
      </p>
      <div className="space-y-1.5">
        {buckets.map((b) => {
          const share = total > 0 ? (b.count / total) * 100 : 0;
          const isOutlier = b.label === "30s+";
          return (
            <div
              key={b.label}
              className="rounded-lg border bg-muted/20 p-2.5"
            >
              <div className="flex items-center justify-between gap-3">
                <span
                  className={cn(
                    "text-xs font-medium",
                    isOutlier && b.count > 0
                      ? "text-amber-600 dark:text-amber-400"
                      : "",
                  )}
                >
                  {b.label}
                  {isOutlier && b.count > 0 && (
                    <TrendingDown className="ml-1 inline size-3 text-amber-500" />
                  )}
                </span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {formatNumber(b.count)} ({share.toFixed(1)}%)
                </span>
              </div>
              <div className="mt-1.5 h-2 overflow-hidden rounded-sm bg-muted">
                <div
                  className={cn(
                    "h-full rounded-sm transition-all",
                    isOutlier ? "bg-amber-500/60" : "bg-rose-500/60",
                  )}
                  style={{ width: `${share}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
