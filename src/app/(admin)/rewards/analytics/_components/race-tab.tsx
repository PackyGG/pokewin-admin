import { Trophy, Flag, Sigma, Crown } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/utils/format";
import { getRaceAnalytics } from "@/lib/queries/rewards-category-analytics";
import { getRaceExtras } from "@/lib/queries/rewards-category-extras";
import { type RewardsPeriod } from "@/lib/queries/rewards-analytics";
import {
  CategoryDeepStatsPanel,
  baseDeepStatsTiles,
  type DeepStatsTile,
} from "./category-deep-stats";

/**
 * Race tab on /rewards/analytics. Surfaces the shared baseline strip
 * (total / count / avg / median / max / unique recipients) plus:
 *
 *   - Distinct races contributing prize claims in the window
 *   - Avg prize per race (total volume / distinct races)
 *   - Largest single prize (from race_claims, paralleled to the
 *     ledger max for sanity)
 *   - Top race in the window (race_type + period_start + total pool +
 *     winner count) — appears below the strip as a callout, NOT as a
 *     KPI tile since it doesn't fit the single-line value shape.
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
  // Race extras tiles sit at the front so the "how many races + per-
  // race average" cohort lens reads first, before the per-payout
  // central tendency stats.
  const extraTiles: DeepStatsTile[] = [
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
  const tiles: DeepStatsTile[] = [...extraTiles, ...base];
  return (
    <div className="space-y-3">
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
      {/* Top race callout — wraps the most-active race in the window
          with race type, period start, total pool, and winner count.
          Only renders when at least one race had winners; otherwise
          the empty state from the panel above already covers it. */}
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
