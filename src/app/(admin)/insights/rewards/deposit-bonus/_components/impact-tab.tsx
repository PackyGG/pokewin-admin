import Link from "next/link";
import {
  Split,
  Crown,
  Layers,
  BarChart3,
  Clock,
  Users,
  Percent,
  Coins,
  Banknote,
  TrendingUp,
  Gauge,
  Repeat,
  UserPlus,
  Wallet,
  Activity,
} from "lucide-react";
import { SectionHeading, KpiTile } from "@/components/modern-panels";
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
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import {
  getDepositBonusDepositFrequency,
  getDepositBonusDepositSizeDistribution,
  getDepositBonusCapHitters,
  getDepositBonusTimeBetween,
  getDepositBonusToWagerSegments,
  getDepositBonusPostCapBehavior,
  getDepositBonusCapHitterCohorts,
  type DepositBonusDepositFrequency,
  type DepositBonusDepositSizeDistribution,
  type DepositBonusCapHitters,
  type DepositBonusTimeBetween,
  type DepositBonusToWagerSegments,
  type DepositBonusPostCapBehavior,
  type DepositBonusCapHitterCohorts,
} from "@/lib/queries/insights-rewards/deposit-bonus/impact";
import {
  compareDepositBonusDepositFrequency,
  compareDepositBonusDepositSizeDistribution,
  compareDepositBonusCapHitters,
  compareDepositBonusTimeBetween,
  compareDepositBonusToWagerSegments,
  compareDepositBonusPostCapBehavior,
  compareDepositBonusCapHitterCohorts,
} from "@/lib/clickhouse/compare/deposit-bonus-impact";
import {
  getDepositBonusDepositFrequencyFromClickHouse,
  getDepositBonusDepositSizeDistributionFromClickHouse,
  getDepositBonusCapHittersFromClickHouse,
  getDepositBonusTimeBetweenFromClickHouse,
  getDepositBonusToWagerSegmentsFromClickHouse,
  getDepositBonusPostCapBehaviorFromClickHouse,
  getDepositBonusCapHitterCohortsFromClickHouse,
} from "@/lib/clickhouse/queries/insights-rewards/deposit-bonus/impact";
import { resolveAdminRead } from "@/lib/clickhouse/resolve-read";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import {
  DepositFrequencyChart,
  DepositSizeChart,
  TimeGapChart,
} from "./impact-charts";

/**
 * Impact tab — models the impact of a potential TIME-SPLIT deposit-bonus
 * cap (splitting the daily bonus cap across smaller time windows) with
 * real data instead of guessing from aggregates.
 *
 * Answers the two headline operating questions FIRST (TL;DR strip):
 *   1. Who triggers the cap?      → cap-hitter count + combined value
 *   2. Typical multi-deposit day? → median deposits/day + median size +
 *                                    median gap
 *
 * Then the detailed sections:
 *   - Deposit-frequency distribution (per-user-per-day)
 *   - Deposit-size distribution (with the ≥ $500 whale callout)
 *   - Cap-hit analysis (the headline cap-hitter list + value contribution)
 *   - Time-between-deposits (LAG gaps)
 *   - Bonus-to-wager subsidy by segment (nice-to-have)
 *   - Post-cap re-deposit behaviour (nice-to-have, approximate)
 *   - New vs returning cap triggers (nice-to-have)
 *
 * House-POV: bonus cost / cap-hitter spend that the house gives → rose.
 * Wager / GGR contribution / deposits (house captures the spend) →
 * emerald. Counts / timing → blue.
 *
 * Every query is `safeQuery`-wrapped so a single failure degrades only
 * its own block. They all run concurrently via Promise.all and are each
 * period-bound, 365d-capped on lifetime, and lazily fetched (this tab
 * only renders when active).
 */
export async function ImpactTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  // All 7 run concurrently; each is statement-timeout bounded so a single
  // pathological scan on the lifetime window degrades to its own fallback
  // tile instead of blocking the whole tab from painting.
  const [freqRes, sizeRes, capRes, gapRes, segRes, postRes, cohortRes] =
    await Promise.all([
      safeQuery(
        () =>
          resolveAdminRead<DepositBonusDepositFrequency>(
            "insights_deposit_bonus_impact_frequency",
            {
              pg: () => getDepositBonusDepositFrequency(period),
              ch: async () =>
                getDepositBonusDepositFrequencyFromClickHouse(
                  period,
                  await getExcludedUserIds(),
                ),
              compare: (pg) =>
                void compareDepositBonusDepositFrequency(period, pg),
            },
          ),
        null,
        "insights-rewards-deposit-bonus.impact.frequency",
        REWARD_QUERY_TIMEOUT_MS,
      ),
      safeQuery(
        () =>
          resolveAdminRead<DepositBonusDepositSizeDistribution>(
            "insights_deposit_bonus_impact_size",
            {
              pg: () => getDepositBonusDepositSizeDistribution(period),
              ch: async () =>
                getDepositBonusDepositSizeDistributionFromClickHouse(
                  period,
                  await getExcludedUserIds(),
                ),
              compare: (pg) =>
                void compareDepositBonusDepositSizeDistribution(period, pg),
            },
          ),
        null,
        "insights-rewards-deposit-bonus.impact.size",
        REWARD_QUERY_TIMEOUT_MS,
      ),
      safeQuery(
        () =>
          resolveAdminRead<DepositBonusCapHitters>(
            "insights_deposit_bonus_impact_cap_hitters",
            {
              pg: () => getDepositBonusCapHitters(period),
              ch: async () =>
                getDepositBonusCapHittersFromClickHouse(
                  period,
                  await getExcludedUserIds(),
                ),
              compare: (pg) => void compareDepositBonusCapHitters(period, pg),
            },
          ),
        null,
        "insights-rewards-deposit-bonus.impact.cap-hitters",
        REWARD_QUERY_TIMEOUT_MS,
      ),
      safeQuery(
        () =>
          resolveAdminRead<DepositBonusTimeBetween>(
            "insights_deposit_bonus_impact_time_between",
            {
              pg: () => getDepositBonusTimeBetween(period),
              ch: async () =>
                getDepositBonusTimeBetweenFromClickHouse(
                  period,
                  await getExcludedUserIds(),
                ),
              compare: (pg) => void compareDepositBonusTimeBetween(period, pg),
            },
          ),
        null,
        "insights-rewards-deposit-bonus.impact.time-between",
        REWARD_QUERY_TIMEOUT_MS,
      ),
      safeQuery(
        () =>
          resolveAdminRead<DepositBonusToWagerSegments>(
            "insights_deposit_bonus_impact_bonus_wager",
            {
              pg: () => getDepositBonusToWagerSegments(period),
              ch: async () =>
                getDepositBonusToWagerSegmentsFromClickHouse(
                  period,
                  await getExcludedUserIds(),
                ),
              compare: (pg) =>
                void compareDepositBonusToWagerSegments(period, pg),
            },
          ),
        null,
        "insights-rewards-deposit-bonus.impact.bonus-wager",
        REWARD_QUERY_TIMEOUT_MS,
      ),
      safeQuery(
        () =>
          resolveAdminRead<DepositBonusPostCapBehavior>(
            "insights_deposit_bonus_impact_post_cap",
            {
              pg: () => getDepositBonusPostCapBehavior(period),
              ch: async () =>
                getDepositBonusPostCapBehaviorFromClickHouse(
                  period,
                  await getExcludedUserIds(),
                ),
              compare: (pg) =>
                void compareDepositBonusPostCapBehavior(period, pg),
            },
          ),
        null,
        "insights-rewards-deposit-bonus.impact.post-cap",
        REWARD_QUERY_TIMEOUT_MS,
      ),
      safeQuery(
        () =>
          resolveAdminRead<DepositBonusCapHitterCohorts>(
            "insights_deposit_bonus_impact_cohorts",
            {
              pg: () => getDepositBonusCapHitterCohorts(period),
              ch: async () =>
                getDepositBonusCapHitterCohortsFromClickHouse(
                  period,
                  await getExcludedUserIds(),
                ),
              compare: (pg) =>
                void compareDepositBonusCapHitterCohorts(period, pg),
            },
          ),
        null,
        "insights-rewards-deposit-bonus.impact.cohorts",
        REWARD_QUERY_TIMEOUT_MS,
      ),
    ]);

  const freq = freqRes.data;
  const size = sizeRes.data;
  const cap = capRes.data;
  const gap = gapRes.data;
  const seg = segRes.data;
  const post = postRes.data;
  const cohort = cohortRes.data;
  const label = insightsRewardsPeriodLabel(period);

  // If every critical query failed AND there's simply no bonus/deposit
  // activity, show a single calm empty state instead of a wall of error
  // tiles.
  const noActivity =
    (!cap || cap.capValue === 0) &&
    (!size || size.totalDeposits === 0) &&
    (!freq || freq.totalUserDays === 0);
  if (noActivity && !freqRes.error && !sizeRes.error && !capRes.error) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Split}
          title={`No deposit activity in ${label.toLowerCase()}`}
          description="A time-split cap can't be modeled without deposits + bonuses in the window."
          compact
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ── TL;DR: the two headline answers ──────────────────────── */}
      <FadeIn>
        <TldrStrip cap={cap} freq={freq} size={size} gap={gap} />
      </FadeIn>

      {/* ── 3. Cap-hit analysis (headline #1) ────────────────────── */}
      <FadeIn>
        <div className="space-y-3">
          <SectionHeading
            icon={Crown}
            title="Who triggers the cap"
            action={
              cap && cap.capValue > 0 ? (
                <span className="text-xs text-muted-foreground">
                  cap = {formatCurrency(cap.capValue)}
                </span>
              ) : undefined
            }
          />
          {capRes.error || !cap ? (
            <TileErrorFallback
              label="Cap-hit analysis"
              hint="The cap-hitter query failed."
              size="panel"
            />
          ) : (
            <CapHitSection cap={cap} />
          )}
        </div>
      </FadeIn>

      {/* ── 1. Deposit-frequency distribution ────────────────────── */}
      <FadeIn>
        <div className="grid gap-4 xl:grid-cols-2">
          <div className="space-y-3">
            <SectionHeading icon={Layers} title="Deposit frequency per day" />
            <div className="relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
              {freqRes.error || !freq ? (
                <TileErrorFallback
                  label="Deposit frequency"
                  hint="Frequency query failed."
                  size="panel"
                />
              ) : (
                <>
                  <DepositFrequencyChart buckets={freq.buckets} />
                  <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                    <MiniStat
                      label="Avg / user-day"
                      value={freq.avgDepositsPerUserDay.toFixed(2)}
                      tint="blue"
                    />
                    <MiniStat
                      label="Median / user-day"
                      value={formatNumber(freq.medianDepositsPerUserDay)}
                      tint="blue"
                    />
                    <MiniStat
                      label="Multi-deposit days"
                      value={`${(freq.multiDepositDayShare * 100).toFixed(1)}%`}
                      tint="rose"
                    />
                  </div>
                </>
              )}
            </div>
          </div>

          {/* ── 2. Deposit-size distribution ───────────────────────── */}
          <div className="space-y-3">
            <SectionHeading icon={BarChart3} title="Deposit size distribution" />
            <div className="relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
              {sizeRes.error || !size ? (
                <TileErrorFallback
                  label="Deposit size"
                  hint="Size-distribution query failed."
                  size="panel"
                />
              ) : (
                <>
                  <DepositSizeChart buckets={size.buckets} />
                  <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                    <MiniStat
                      label="Deposits ≥ $500"
                      value={formatNumber(size.largeDepositCount)}
                      tint="rose"
                    />
                    <MiniStat
                      label="% ≥ $500"
                      value={`${(size.largeDepositCountShare * 100).toFixed(1)}%`}
                      tint="rose"
                    />
                    <MiniStat
                      label="Median deposit"
                      value={formatCurrency(size.medianDepositUsd)}
                      tint="emerald"
                    />
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </FadeIn>

      {/* ── 2b. ≥$500 detail table ───────────────────────────────── */}
      {size && size.totalDeposits > 0 && (
        <FadeIn>
          <div className="space-y-3">
            <SectionHeading
              icon={Banknote}
              title="Deposit-size bands — full breakdown"
            />
            <div className="relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
              <DepositSizeTable size={size} />
            </div>
          </div>
        </FadeIn>
      )}

      {/* ── 4. Time-between-deposits ─────────────────────────────── */}
      <FadeIn>
        <div className="space-y-3">
          <SectionHeading
            icon={Clock}
            title="Time between consecutive deposits"
          />
          <div className="relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
            {gapRes.error || !gap ? (
              <TileErrorFallback
                label="Time-between-deposits"
                hint="Gap query failed."
                size="panel"
              />
            ) : gap.totalGaps === 0 ? (
              <EmptyState
                icon={Clock}
                title="No consecutive deposits"
                description="Users need ≥ 2 deposits in window to measure a gap."
                compact
              />
            ) : (
              <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
                <TimeGapChart buckets={gap.buckets} />
                <div className="grid grid-cols-2 gap-2 self-start lg:grid-cols-1">
                  <MiniStat
                    label="Median gap"
                    value={formatMinutes(gap.medianGapMinutes)}
                    tint="blue"
                  />
                  <MiniStat
                    label="P25 – P75 gap"
                    value={`${formatMinutes(gap.p25GapMinutes)} – ${formatMinutes(gap.p75GapMinutes)}`}
                    tint="blue"
                  />
                  <MiniStat
                    label="Gaps under 24h"
                    value={`${(gap.intraDayShare * 100).toFixed(1)}%`}
                    tint="rose"
                  />
                  <MiniStat
                    label="Gaps surveyed"
                    value={formatNumber(gap.totalGaps)}
                    tint="blue"
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </FadeIn>

      {/* ── 5. Bonus-to-wager subsidy by segment (nice-to-have) ──── */}
      {seg && seg.segments.some((s) => s.users > 0) && (
        <FadeIn>
          <div className="space-y-3">
            <SectionHeading
              icon={Gauge}
              title="Bonus-to-wager subsidy by deposit-size segment"
            />
            <div className="relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
              <BonusWagerTable seg={seg} />
            </div>
          </div>
        </FadeIn>
      )}

      {/* ── 6 + 8. Post-cap behaviour + cohorts (nice-to-have) ───── */}
      <FadeIn>
        <div className="grid gap-4 xl:grid-cols-2">
          {post && post.capValue > 0 && post.capHitters > 0 && (
            <div className="space-y-3">
              <SectionHeading
                icon={Repeat}
                title="Re-deposit behaviour after first cap hit"
                action={
                  <span className="text-xs text-muted-foreground">approx.</span>
                }
              />
              <div className="relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
                <PostCapSection post={post} />
              </div>
            </div>
          )}

          {cohort && cohort.capValue > 0 && (
            <div className="space-y-3">
              <SectionHeading
                icon={UserPlus}
                title="New vs returning cap triggers"
              />
              <div className="relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
                <CohortSection cohort={cohort} period={period} />
              </div>
            </div>
          )}
        </div>
      </FadeIn>
    </div>
  );
}

// ─── TL;DR strip — the two headline answers ─────────────────────────

function TldrStrip({
  cap,
  freq,
  size,
  gap,
}: {
  cap: DepositBonusCapHitters | null;
  freq: { medianDepositsPerUserDay: number } | null;
  size: { medianDepositUsd: number } | null;
  gap: DepositBonusTimeBetween | null;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* Headline 1 — who triggers the cap */}
      <div className="relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
        <div className="relative flex items-center gap-2 text-rose-600 dark:text-rose-400">
          <Crown className="size-4" />
          <span className="text-xs font-semibold uppercase tracking-wider">
            Who triggers the cap
          </span>
        </div>
        <p className="relative mt-2 text-3xl font-bold tracking-tight tabular-nums text-rose-600 dark:text-rose-400">
          {cap ? formatNumber(cap.distinctCapHitters) : "—"}
          <span className="ml-2 text-base font-medium text-muted-foreground">
            cap-hitters
          </span>
        </p>
        <p className="relative mt-1 text-sm text-muted-foreground">
          {cap ? (
            <>
              {(cap.capHitterShare * 100).toFixed(1)}% of {formatNumber(cap.totalDepositors)}{" "}
              depositors · combined wager{" "}
              <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                {formatCurrency(cap.combinedWager)}
              </span>{" "}
              ({(cap.wagerShare * 100).toFixed(1)}% of all depositor wager)
            </>
          ) : (
            "Cap-hitter data unavailable."
          )}
        </p>
      </div>

      {/* Headline 2 — typical multi-deposit day */}
      <div className="relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
        <div className="relative flex items-center gap-2 text-blue-600 dark:text-blue-400">
          <Activity className="size-4" />
          <span className="text-xs font-semibold uppercase tracking-wider">
            Typical deposit day
          </span>
        </div>
        <div className="relative mt-2 flex flex-wrap items-baseline gap-x-6 gap-y-1">
          <div>
            <p className="text-3xl font-bold tracking-tight tabular-nums text-blue-600 dark:text-blue-400">
              {freq ? formatNumber(freq.medianDepositsPerUserDay) : "—"}
            </p>
            <p className="text-[11px] text-muted-foreground">median deposits/day</p>
          </div>
          <div>
            <p className="text-3xl font-bold tracking-tight tabular-nums text-emerald-600 dark:text-emerald-400">
              {size ? formatCurrency(size.medianDepositUsd) : "—"}
            </p>
            <p className="text-[11px] text-muted-foreground">median size</p>
          </div>
          <div>
            <p className="text-3xl font-bold tracking-tight tabular-nums text-blue-600 dark:text-blue-400">
              {gap && gap.totalGaps > 0 ? formatMinutes(gap.medianGapMinutes) : "—"}
            </p>
            <p className="text-[11px] text-muted-foreground">median gap</p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Cap-hit section (headline #1 detail) ───────────────────────────

function CapHitSection({ cap }: { cap: DepositBonusCapHitters }) {
  if (cap.capValue === 0) {
    return (
      <div className="relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
        <EmptyState
          icon={Crown}
          title="No cap hits in window"
          description="No bonuses reached the empirical cap value."
          compact
        />
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <KpiTile
          label="Distinct cap-hitters"
          value={formatNumber(cap.distinctCapHitters)}
          sub="hit the cap ≥ 1×"
          icon={Users}
          accent="blue"
        />
        <KpiTile
          label="% of depositors"
          value={`${(cap.capHitterShare * 100).toFixed(1)}%`}
          sub={`of ${formatNumber(cap.totalDepositors)} depositors`}
          icon={Percent}
          accent="amber"
        />
        <KpiTile
          label="Combined wager"
          value={formatCurrency(cap.combinedWager)}
          sub="all cap-hitters"
          icon={Coins}
          accent="emerald"
        />
        <KpiTile
          label="Wager share"
          value={`${(cap.wagerShare * 100).toFixed(1)}%`}
          sub="of all depositor wager"
          icon={TrendingUp}
          accent="emerald"
        />
        <KpiTile
          label="Combined GGR"
          value={formatCurrency(cap.combinedGgr)}
          sub="wager − payouts"
          icon={Wallet}
          accent={cap.combinedGgr >= 0 ? "emerald" : "rose"}
        />
      </div>

      <div className="relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
        {cap.rows.length > 0 ? (
          <CapHittersTable rows={cap.rows} />
        ) : (
          <EmptyState
            icon={Crown}
            title="No cap-hitters"
            description="No users hit the cap in this window."
            compact
          />
        )}
      </div>
    </div>
  );
}

function CapHittersTable({ rows }: { rows: DepositBonusCapHitters["rows"] }) {
  return (
    <>
      {/* Mobile cards */}
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
                {r.capHits}× cap{r.frequent ? " · frequent" : ""} · dep{" "}
                {formatCurrency(r.depositTotal)}
              </span>
            </div>
            <div className="shrink-0 text-right">
              <p className="text-sm font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
                {formatCurrency(r.wagerTotal)}
              </p>
              <p
                className={`text-[10px] tabular-nums ${r.ggrContribution >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}
              >
                GGR {formatCurrency(r.ggrContribution)}
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
              <TableHead className="w-[50px]">Rank</TableHead>
              <TableHead>User</TableHead>
              <TableHead className="text-right">Cap hits</TableHead>
              <TableHead className="text-right">Deposits</TableHead>
              <TableHead className="text-right">Bonus</TableHead>
              <TableHead className="text-right">Wager</TableHead>
              <TableHead className="text-right">GGR</TableHead>
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
                  {r.frequent && (
                    <span className="ml-1.5 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                      freq
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                  {formatCurrency(r.depositTotal)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                  {formatCurrency(r.bonusTotal)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                  {formatCurrency(r.wagerTotal)}
                </TableCell>
                <TableCell
                  className={`text-right tabular-nums ${r.ggrContribution >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}
                >
                  {formatCurrency(r.ggrContribution)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

// ─── Deposit-size detail table ──────────────────────────────────────

function DepositSizeTable({
  size,
}: {
  size: NonNullable<
    Awaited<ReturnType<typeof getDepositBonusDepositSizeDistribution>>
  >;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Band</TableHead>
          <TableHead className="text-right">Deposits</TableHead>
          <TableHead className="text-right">% of count</TableHead>
          <TableHead className="text-right">Volume</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {size.buckets.map((b) => (
          <TableRow key={b.label} className={b.isLarge ? "bg-rose-500/[0.04]" : undefined}>
            <TableCell className="font-medium">
              {b.label}
              {b.isLarge && (
                <span className="ml-1.5 rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-medium text-rose-600 dark:text-rose-400">
                  ≥ $500
                </span>
              )}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {formatNumber(b.count)}
            </TableCell>
            <TableCell className="text-right tabular-nums text-muted-foreground">
              {(b.countShare * 100).toFixed(1)}%
            </TableCell>
            <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
              {formatCurrency(b.volume)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// ─── Bonus-to-wager subsidy table (nice-to-have) ────────────────────

function BonusWagerTable({ seg }: { seg: DepositBonusToWagerSegments }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Deposit segment</TableHead>
          <TableHead className="text-right">Users</TableHead>
          <TableHead className="text-right">Avg bonus</TableHead>
          <TableHead className="text-right">Avg wager</TableHead>
          <TableHead className="text-right">Subsidy (bonus / wager)</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {seg.segments.map((s) => (
          <TableRow key={s.label}>
            <TableCell className="font-medium">{s.label}</TableCell>
            <TableCell className="text-right tabular-nums">
              {formatNumber(s.users)}
            </TableCell>
            <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
              {formatCurrency(s.avgBonus)}
            </TableCell>
            <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
              {formatCurrency(s.avgWager)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {s.subsidyRatio != null ? `${(s.subsidyRatio * 100).toFixed(1)}%` : "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// ─── Post-cap behaviour (nice-to-have) ──────────────────────────────

function PostCapSection({ post }: { post: DepositBonusPostCapBehavior }) {
  const keptShare =
    post.capHitters > 0 ? post.keptDepositing / post.capHitters : 0;
  const noBonusShare =
    post.postCapDepositsTotal > 0
      ? post.postCapDepositsNoBonus / post.postCapDepositsTotal
      : 0;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <MiniStat
          label="Kept depositing"
          value={`${formatNumber(post.keptDepositing)} (${(keptShare * 100).toFixed(0)}%)`}
          tint="emerald"
        />
        <MiniStat
          label="Stopped after cap"
          value={formatNumber(post.stopped)}
          tint="rose"
        />
        <MiniStat
          label="Post-cap deposits"
          value={formatNumber(post.postCapDepositsTotal)}
          tint="blue"
        />
        <MiniStat
          label="…with no extra bonus"
          value={`${formatNumber(post.postCapDepositsNoBonus)} (${(noBonusShare * 100).toFixed(0)}%)`}
          tint="emerald"
        />
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Approximation: counts any completed deposit a cap-hitter makes after
        their first cap hit in the window. &ldquo;No extra bonus&rdquo; means no
        bonus paired (balance-match within 30s) to that later deposit — i.e.
        they deposited despite the cap being exhausted. A high share here is
        the strongest signal that a tighter time-split cap would NOT suppress
        deposits.
      </p>
    </div>
  );
}

// ─── New vs returning cohorts (nice-to-have) ────────────────────────

function CohortSection({
  cohort,
  period,
}: {
  cohort: DepositBonusCapHitterCohorts;
  period: InsightsRewardsPeriod;
}) {
  const lifetime = period === "all";
  return (
    <div className="space-y-3">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Cohort</TableHead>
            <TableHead className="text-right">Hitters</TableHead>
            <TableHead className="text-right">Cap hits</TableHead>
            <TableHead className="text-right">Deposits</TableHead>
            <TableHead className="text-right">Wager</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <CohortRow label="New (signed up in window)" side={cohort.newCohort} />
          <CohortRow label="Returning" side={cohort.returningCohort} />
        </TableBody>
      </Table>
      {lifetime && (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          On the lifetime window there is no &ldquo;new within window&rdquo;
          notion — every cap-hitter rolls into &ldquo;returning&rdquo;. Pick a
          finite period to split new vs returning.
        </p>
      )}
    </div>
  );
}

function CohortRow({
  label,
  side,
}: {
  label: string;
  side: DepositBonusCapHitterCohorts["newCohort"];
}) {
  return (
    <TableRow>
      <TableCell className="font-medium">{label}</TableCell>
      <TableCell className="text-right tabular-nums">
        {formatNumber(side.users)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {formatNumber(side.capHits)}
      </TableCell>
      <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
        {formatCurrency(side.depositTotal)}
      </TableCell>
      <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
        {formatCurrency(side.wagerTotal)}
      </TableCell>
    </TableRow>
  );
}

// ─── Small shared bits ──────────────────────────────────────────────

function MiniStat({
  label,
  value,
  tint,
}: {
  label: string;
  value: string;
  tint: "blue" | "emerald" | "rose";
}) {
  const tintClass =
    tint === "emerald"
      ? "text-emerald-600 dark:text-emerald-400"
      : tint === "rose"
        ? "text-rose-600 dark:text-rose-400"
        : "text-blue-600 dark:text-blue-400";
  return (
    <div className="rounded-lg border bg-muted/20 p-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className={`mt-0.5 text-base font-bold tabular-nums ${tintClass}`}>
        {value}
      </p>
    </div>
  );
}

/**
 * Format a minute count into a compact human gap. Display-only chrome for
 * the time-between-deposits stats (the shared format util has no duration
 * helper and this is not a reusable domain concept).
 */
function formatMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "0m";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours.toFixed(hours < 10 ? 1 : 0)}h`;
  const days = hours / 24;
  return `${days.toFixed(days < 10 ? 1 : 0)}d`;
}
