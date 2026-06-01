import Link from "next/link";
import {
  Trophy,
  Flag,
  Sigma,
  Crown,
  Target,
  PieChart,
  Repeat,
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
import { formatCurrency, formatDate, formatNumber } from "@/lib/utils/format";
import { getRaceAnalytics } from "@/lib/queries/rewards-category-analytics";
import { getRaceExtras } from "@/lib/queries/rewards-category-extras";
import { type RewardsPeriod } from "@/lib/queries/rewards-analytics";
import {
  CategoryDeepStatsPanel,
  baseDeepStatsTiles,
  type DeepStatsTile,
} from "./category-deep-stats";
import { DistributionBarChart } from "./distribution-bar-chart";

/**
 * Race tab on /rewards/analytics. Baseline + race extras + winner
 * position distribution + repeat winners + budget utilisation.
 *
 * Tiles in the KPI strip (order = cohort lens first, central tendency
 * next, outliers / budget last):
 *   - Distinct races, avg prize / race  (cohort lens)
 *   - Baseline (volume, count, avg, median, max, unique recipients)
 *   - Budget utilisation = SUM of prize tiers across races run vs
 *     total volume paid → tells the team if races regularly pay out
 *     less than their configured budget (under-claimed top tiers).
 *   - Avg + median winner position (skew lens).
 *
 * Below the strip:
 *   - Top race callout (race_type + period_start + total pool +
 *     winner count) — already shipped.
 *   - Position bucket distribution (top 3 / 4-10 / 11-25 / 26+).
 *   - Repeat winners — count + top 5 by total prize across races.
 *
 * House-POV: race prizes are money the house GIVES users → rose.
 */
export async function RaceTab({
  period,
  periodLabel,
}: {
  period: RewardsPeriod;
  periodLabel: string;
}) {
  const [data, extras] = await Promise.all([
    getRaceAnalytics(period),
    getRaceExtras(period),
  ]);
  const base = baseDeepStatsTiles(data, periodLabel, {
    countSub: "Prizes paid",
    avgPerUserSub: "avg per winner",
  });
  // Front-load cohort lens so admins see "how many races + per-race
  // average" before per-payout stats. Budget + position tiles
  // appended at the end so the strip reads
  // "races → payouts → budget → skew".
  const extraTilesFront: DeepStatsTile[] = [
    {
      label: "Distinct races",
      value: extras.distinctRaces.toLocaleString(),
      sub: "Races with at least 1 winner",
      icon: Flag,
    },
    {
      label: "Avg prize / race",
      value: formatCurrency(extras.avgPrizePerRace),
      sub: "Total volume / race count",
      icon: Sigma,
    },
  ];
  const extraTilesBack: DeepStatsTile[] = [
    {
      label: "Budget utilisation",
      value:
        extras.budgetForRunRaces > 0
          ? `${(extras.budgetUtilisation * 100).toFixed(1)}%`
          : "—",
      sub:
        extras.budgetForRunRaces > 0
          ? `${formatCurrency(data.totalVolume)} of ${formatCurrency(extras.budgetForRunRaces)}`
          : "No configured budget",
      icon: Target,
    },
    {
      label: "Avg winner position",
      value:
        extras.avgWinnerPosition > 0
          ? `#${extras.avgWinnerPosition.toFixed(1)}`
          : "—",
      sub:
        extras.medianWinnerPosition > 0
          ? `Median #${extras.medianWinnerPosition.toFixed(0)}`
          : "No data",
      icon: PieChart,
    },
  ];
  const tiles: DeepStatsTile[] = [...extraTilesFront, ...base, ...extraTilesBack];
  return (
    <div className="space-y-6">
      <CategoryDeepStatsPanel
        data={data}
        periodLabel={periodLabel}
        headerIcon={Trophy}
        headerTitle="Race"
        tiles={tiles}
        unitLabel="prizes"
        emptyTitle="No race prizes in this window"
        emptyDescription={`No race prizes were paid in the ${periodLabel.toLowerCase()} period. Try a longer period.`}
      />
      {/* Top race callout — already shipped. Wraps the most-active
          race in the window with race type, period start, total
          pool, and winner count. Only renders when at least one
          race had winners. */}
      {data.count > 0 && extras.topRace && (
        <div className="surface-sheen relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-lg bg-rose-500/10">
              <Crown className="size-5 text-rose-500" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Most active race
              </p>
              <p className="text-sm font-medium">
                {labelForRaceType(extras.topRace.raceType)} ·{" "}
                {formatDate(extras.topRace.periodStart)}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {extras.topRace.winnerCount}{" "}
                {extras.topRace.winnerCount === 1 ? "winner" : "winners"}
              </p>
            </div>
            <p className="text-xl font-bold tabular-nums text-rose-600 dark:text-rose-400 sm:text-2xl">
              {formatCurrency(extras.topRace.totalPrizePool)}
            </p>
          </div>
        </div>
      )}

      {/* Position bucket distribution */}
      {data.count > 0 && (
        <div className="space-y-3">
          <SectionHeading icon={PieChart} title="Winner position spread" />
          <div className="surface-sheen relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
            <p className="text-[11px] text-muted-foreground">
              Where prize claims land. Lower buckets dominating means
              races skew top-heavy.
            </p>
            <div className="mt-3">
              <DistributionBarChart
                data={extras.positionBuckets}
                metric="count"
              />
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {extras.positionBuckets.map((b) => (
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

      {/* Repeat winners — top 5 by total prize */}
      {data.count > 0 && extras.repeatWinnerCount > 0 && (
        <div className="space-y-3">
          <SectionHeading
            icon={Repeat}
            title={`Repeat winners (${formatNumber(extras.repeatWinnerCount)})`}
          />
          <div className="surface-sheen relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
            <p className="text-[11px] text-muted-foreground">
              Users who placed in more than one race in this window.
              Top 5 by total prize volume.
            </p>
            {/* Mobile cards */}
            <div className="mt-3 space-y-1.5 md:hidden">
              {extras.topRepeatWinners.map((w, i) => (
                <div
                  key={w.userId}
                  className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5"
                >
                  <span className="w-7 shrink-0 text-xs tabular-nums text-muted-foreground">
                    #{i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/users/${w.userId}`}
                      className="block truncate text-sm font-medium hover:underline"
                    >
                      {w.username ?? w.userId.slice(0, 8)}
                    </Link>
                    <span className="text-[11px] tabular-nums text-muted-foreground">
                      {formatNumber(w.races)} races
                    </span>
                  </div>
                  <span className="shrink-0 text-sm font-medium tabular-nums text-rose-600 dark:text-rose-400">
                    {formatCurrency(w.totalPrize)}
                  </span>
                </div>
              ))}
            </div>
            {/* Desktop table */}
            <div className="mt-3 hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[50px]">Rank</TableHead>
                    <TableHead>User</TableHead>
                    <TableHead className="text-right">Races</TableHead>
                    <TableHead className="text-right">Total prize</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {extras.topRepeatWinners.map((w, i) => (
                    <TableRow key={w.userId}>
                      <TableCell className="tabular-nums text-muted-foreground">
                        #{i + 1}
                      </TableCell>
                      <TableCell className="font-medium">
                        <Link
                          href={`/users/${w.userId}`}
                          className="hover:underline"
                        >
                          {w.username ?? w.userId.slice(0, 8)}
                        </Link>
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {formatNumber(w.races)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                        {formatCurrency(w.totalPrize)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Pretty-print a race_type enum (`daily` / `weekly` / `monthly`) for
 * the top-race callout. Defensive fallback for any future race type
 * so the label degrades to title-case rather than crashing.
 */
function labelForRaceType(t: string): string {
  if (t === "daily") return "Daily race";
  if (t === "weekly") return "Weekly race";
  if (t === "monthly") return "Monthly race";
  return t.charAt(0).toUpperCase() + t.slice(1) + " race";
}
