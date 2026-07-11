import {
  TrendingDown,
  Users,
  Hash,
  ArrowUpRight,
  Sigma,
  Coins,
  Target,
  LineChart as LineChartIcon,
  CalendarDays,
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
import { formatCurrency, formatDate, formatNumber } from "@/lib/utils/format";
import { safeQuery } from "@/lib/errors/safe-query";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { getDepositBonusOverview } from "@/lib/queries/insights-rewards/deposit-bonus/overview";
import { getDepositBonusCapHitRate } from "@/lib/queries/insights-rewards/deposit-bonus/cap-analysis";
import {
  getDepositBonusDailyBreakdown,
  type DepositBonusDailyRow,
} from "@/lib/queries/insights-rewards/deposit-bonus/daily-breakdown";
import { compareDepositBonusOverview } from "@/lib/clickhouse/compare/insights-deposit-bonus-overview";
import { compareDepositBonusCapHitRate } from "@/lib/clickhouse/compare/insights-deposit-bonus-cap-hit-rate";
import { compareDepositBonusDailyBreakdown } from "@/lib/clickhouse/compare/deposit-bonus-daily";
import { getDepositBonusDailyBreakdownFromClickHouse } from "@/lib/clickhouse/queries/insights-rewards/deposit-bonus/daily-breakdown";
import { resolveAdminRead } from "@/lib/clickhouse/resolve-read";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { DepositBonusChart } from "@/app/(admin)/rewards/analytics/deposit-bonus-chart";

/**
 * Overview tab on /insights/rewards/deposit-bonus.
 *
 * Headline lens on the period — top KPI strip (cost, count, claimants,
 * avg/median/max bonus, cap value, cap-hit rate), period-over-period
 * delta vs the prior equal window, daily volume chart, and the day-by-
 * day breakdown table with deposits / attach rate / bonus volume /
 * ratio.
 *
 * House-POV: deposit bonus is a payout the house GIVES users → rose.
 * The KPI strip uses rose for cost-side tiles; blue for neutral
 * (count, claimants); amber for the cap-hit rate so a high hit rate
 * (= many users hitting the ceiling) reads as a warning signal.
 */
export async function OverviewTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const [overviewRes, capRes, dailyRes] = await Promise.all([
    safeQuery(
      () => getDepositBonusOverview(period),
      null,
      "insights-rewards-deposit-bonus.overview",
    ),
    // Lightweight cap-hit-rate only — the KPI strip needs a single
    // number, not the full cap analysis (histogram / top-hitters /
    // biggest-cap-deposit pairing). That heavier query lives on the
    // Cap & Ratio tab.
    safeQuery(
      () => getDepositBonusCapHitRate(period),
      null,
      "insights-rewards-deposit-bonus.cap-hit-rate",
    ),
    safeQuery(
      () =>
        resolveAdminRead<DepositBonusDailyRow[]>(
          "insights_deposit_bonus_daily_breakdown",
          {
            pg: () => getDepositBonusDailyBreakdown(period),
            ch: async () =>
              getDepositBonusDailyBreakdownFromClickHouse(
                period,
                await getExcludedUserIds(),
              ),
            compare: (pg) =>
              void compareDepositBonusDailyBreakdown(period, pg),
          },
        ),
      [],
      "insights-rewards-deposit-bonus.daily",
    ),
  ]);

  if (overviewRes.error || !overviewRes.data) {
    return (
      <TileErrorFallback
        label="Deposit Bonus — Overview"
        hint="The overview query failed. Check server logs."
        size="panel"
      />
    );
  }
  const overview = overviewRes.data;
  const cap = capRes.data;
  const daily = dailyRes.data;
  const label = insightsRewardsPeriodLabel(period);

  // Fire-and-forget ClickHouse comparison (no-op unless the surface flag is in
  // `comparison` mode). The served value stays the Postgres payload above.
  void compareDepositBonusOverview(period, {
    totalCost: overview.totalCost,
    count: overview.count,
    uniqueClaimants: overview.uniqueClaimants,
    depositors: overview.depositors,
    max: overview.max,
  });
  if (cap) {
    void compareDepositBonusCapHitRate(period, {
      capValue: cap.capValue,
      capHits: cap.capHits,
      totalCount: cap.totalCount,
    });
  }

  if (overview.count === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Coins}
          title={`No deposit bonuses in ${label.toLowerCase()}`}
          description="No deposit_bonus ledger rows for this window. Try a longer period."
          compact
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <FadeIn>
        <KpiStrip overview={overview} capHitRate={cap?.capHitRate ?? null} />
      </FadeIn>

      <FadeIn>
        <div className="relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
          <div className="relative">
            <SectionHeading
              icon={LineChartIcon}
              title={`Daily bonus volume — ${label}`}
            />
            <div className="mt-3">
              <DepositBonusChart
                daily={overview.dailyVolume.map((d) => ({
                  date: d.date,
                  volume: d.volume,
                  count: d.count,
                }))}
              />
            </div>
          </div>
        </div>
      </FadeIn>

      <FadeIn>
        <div className="space-y-3">
          <SectionHeading
            icon={CalendarDays}
            title={`Daily breakdown — ${label}`}
          />
          <div className="relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
            {daily.length > 0 ? (
              <DailyBreakdownTable rows={daily} />
            ) : (
              <EmptyState
                icon={CalendarDays}
                title="No daily activity"
                description="No rows in this window."
                compact
              />
            )}
          </div>
        </div>
      </FadeIn>
    </div>
  );
}

// ─── KPI strip ──────────────────────────────────────────────────────

function KpiStrip({
  overview,
  capHitRate,
}: {
  overview: NonNullable<Awaited<ReturnType<typeof getDepositBonusOverview>>>;
  capHitRate: number | null;
}) {
  const prior = overview.priorWindow;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-8">
      <KpiTile
        label="Total cost"
        value={formatCurrency(overview.totalCost)}
        sub={formatDeltaSub(prior?.costDelta ?? null)}
        icon={TrendingDown}
        accent="rose"
      />
      <KpiTile
        label="Bonuses awarded"
        value={formatNumber(overview.count)}
        sub={formatDeltaSub(prior?.countDelta ?? null)}
        icon={Hash}
        accent="rose"
      />
      <KpiTile
        label="Unique claimants"
        value={formatNumber(overview.uniqueClaimants)}
        sub={formatDeltaSub(prior?.claimantDelta ?? null)}
        icon={Users}
        accent="blue"
      />
      <KpiTile
        label="Avg bonus"
        value={formatCurrency(overview.avg)}
        sub="per claim"
        icon={Sigma}
        accent="rose"
      />
      <KpiTile
        label="Median bonus"
        value={formatCurrency(overview.median)}
        sub="per claim"
        icon={Sigma}
        accent="rose"
      />
      <KpiTile
        label="Max bonus"
        value={formatCurrency(overview.max)}
        sub="empirical cap"
        icon={ArrowUpRight}
        accent="rose"
      />
      <KpiTile
        label="Cap hit rate"
        value={capHitRate != null ? `${(capHitRate * 100).toFixed(1)}%` : "—"}
        sub={capHitRate != null && capHitRate > 0.5 ? "Many hit cap" : "ceiling pressure"}
        icon={Target}
        accent="amber"
      />
      <KpiTile
        label="Avg per claimant"
        value={
          overview.uniqueClaimants > 0
            ? formatCurrency(overview.totalCost / overview.uniqueClaimants)
            : "—"
        }
        sub="lifetime $ / user (window)"
        icon={Coins}
        accent="rose"
      />
    </div>
  );
}

function formatDeltaSub(delta: number | null): string {
  if (delta === null) return "vs prior — no prior frame";
  if (delta === 0) return "no change vs prior";
  const arrow = delta > 0 ? "▲" : "▼";
  return `${arrow} ${(Math.abs(delta) * 100).toFixed(1)}% vs prior`;
}

// ─── Daily breakdown table ──────────────────────────────────────────

function DailyBreakdownTable({
  rows,
}: {
  rows: Array<{
    date: string;
    depositCount: number;
    depositVolume: number;
    depositWithBonusCount: number;
    bonusCount: number;
    bonusVolume: number;
    uniqueClaimants: number;
    bonusToDepositRatio: number;
    attachRate: number;
    avgBonus: number;
  }>;
}) {
  return (
    <>
      {/* Mobile cards (<md) — keep the most critical columns. */}
      <div className="space-y-1.5 md:hidden">
        {rows.map((r) => (
          <div
            key={r.date}
            className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{formatDate(r.date)}</p>
              <p className="text-[11px] tabular-nums text-muted-foreground">
                {formatNumber(r.bonusCount)} bonus · {formatNumber(r.depositCount)} deposit
              </p>
            </div>
            <div className="shrink-0 text-right">
              <p className="text-sm font-medium tabular-nums text-rose-600 dark:text-rose-400">
                {formatCurrency(r.bonusVolume)}
              </p>
              <p className="text-[10px] tabular-nums text-muted-foreground">
                {(r.attachRate * 100).toFixed(0)}% attach · {(r.bonusToDepositRatio * 100).toFixed(0)}% ratio
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
              <TableHead>Date</TableHead>
              <TableHead className="text-right">Deposits</TableHead>
              <TableHead className="text-right">Deposit $</TableHead>
              <TableHead className="text-right">w/ bonus</TableHead>
              <TableHead className="text-right">Attach</TableHead>
              <TableHead className="text-right">Bonuses</TableHead>
              <TableHead className="text-right">Bonus $</TableHead>
              <TableHead className="text-right">Avg bonus</TableHead>
              <TableHead className="text-right">Ratio</TableHead>
              <TableHead className="text-right">Claimants</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.date}>
                <TableCell className="font-medium">{formatDate(r.date)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatNumber(r.depositCount)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                  {formatCurrency(r.depositVolume)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatNumber(r.depositWithBonusCount)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {(r.attachRate * 100).toFixed(1)}%
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatNumber(r.bonusCount)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                  {formatCurrency(r.bonusVolume)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCurrency(r.avgBonus)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {(r.bonusToDepositRatio * 100).toFixed(1)}%
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatNumber(r.uniqueClaimants)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
