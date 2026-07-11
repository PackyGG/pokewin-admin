import {
  CalendarClock,
  Flag,
  TrendingDown,
  Users,
  Sigma,
  Target,
  Percent,
} from "lucide-react";
import {
  KpiTile,
  SectionHeading,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { safeQuery } from "@/lib/errors/safe-query";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import {
  getRaceInsightsPerType,
  type RacePerTypeRow,
} from "@/lib/queries/insights-rewards/race/per-type";
import { compareRacePerType } from "@/lib/clickhouse/compare/insights-race-per-type";

const TYPE_LABEL: Record<RacePerTypeRow["raceType"], string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};

/**
 * Per-type tab on /insights/rewards/race. One panel per race type
 * (daily / weekly / monthly), each carrying KPI tiles + a tier-budget
 * usage bar.
 *
 * House-POV: prize spend → rose. Tier utilisation tile renders amber
 * when budget is overrun (rare; treated as a flag, not "good/bad").
 */
export async function RacePerTypeTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const res = await safeQuery(
    () => getRaceInsightsPerType(period),
    [],
    "insights-rewards.race.per-type",
  );
  if (res.error) {
    return (
      <TileErrorFallback
        label="Race — Per type"
        hint="The per-race-type query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }
  const rows = res.data;
  const label = insightsRewardsPeriodLabel(period);

  void compareRacePerType(period, rows);

  const anyActivity = rows.some((r) => r.distinctRaces > 0);
  if (!anyActivity) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={CalendarClock}
          title={`No race-type activity in ${label.toLowerCase()}`}
          description="No daily / weekly / monthly race instances paid out in this window. Try a longer period."
          compact
        />
      </div>
    );
  }

  return (
    <FadeIn>
      <div className="space-y-6">
        {rows.map((row) => (
          <PerTypeSection key={row.raceType} row={row} period={label} />
        ))}
      </div>
    </FadeIn>
  );
}

function PerTypeSection({
  row,
  period,
}: {
  row: RacePerTypeRow;
  period: string;
}) {
  const conversionLabel =
    row.conversionRate === null
      ? "—"
      : `${(row.conversionRate * 100).toFixed(1)}%`;
  const utilisationLabel =
    row.tierUtilisation === null
      ? "—"
      : `${(row.tierUtilisation * 100).toFixed(1)}%`;
  const overBudget =
    row.tierUtilisation !== null && row.tierUtilisation > 1;
  return (
    <div className="space-y-3">
      <SectionHeading
        icon={CalendarClock}
        title={`${TYPE_LABEL[row.raceType]} races`}
      />
      <div className="relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
        {row.distinctRaces === 0 ? (
          <p className="text-sm text-muted-foreground">
            No {TYPE_LABEL[row.raceType].toLowerCase()} race instances paid out in {period}.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <KpiTile
                label="Races run"
                value={formatNumber(row.distinctRaces)}
                sub="With ≥1 winner"
                icon={Flag}
                accent="blue"
              />
              <KpiTile
                label="Prize pool"
                value={formatCurrency(row.prizePoolTotal)}
                sub={`${formatNumber(row.winnerCount)} prize lines`}
                icon={TrendingDown}
                accent="rose"
              />
              <KpiTile
                label="Distinct winners"
                value={formatNumber(row.distinctWinners)}
                sub="Unique users placed"
                icon={Users}
                accent="blue"
              />
              <KpiTile
                label="Avg prize / race"
                value={formatCurrency(row.avgPrizePerRace)}
                sub="Pool / race count"
                icon={Sigma}
                accent="rose"
              />
              <KpiTile
                label="Avg entrants"
                value={
                  row.avgEntrantsPerRace > 0
                    ? row.avgEntrantsPerRace.toFixed(1)
                    : "—"
                }
                sub="Snapshots / race"
                icon={Users}
                accent="cyan"
              />
              <KpiTile
                label="Conversion"
                value={conversionLabel}
                sub="Winners / entrants"
                icon={Percent}
                accent="cyan"
              />
            </div>

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div className="rounded-xl border bg-muted/20 p-4">
                <div className="flex items-center gap-2">
                  <Target className="size-3.5 text-rose-500" />
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Tier utilisation
                  </p>
                </div>
                <p
                  className={cn(
                    "mt-1 text-2xl font-bold tabular-nums",
                    overBudget
                      ? "text-amber-600 dark:text-amber-400"
                      : "text-rose-600 dark:text-rose-400",
                  )}
                >
                  {utilisationLabel}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Paid {formatCurrency(row.prizePoolTotal)} of {formatCurrency(row.tierBudgetForWindow)} configured
                </p>
                <div className="mt-2 h-2 overflow-hidden rounded-sm bg-muted">
                  <div
                    className={cn(
                      "h-full rounded-sm transition-all",
                      overBudget ? "bg-amber-500/60" : "bg-rose-500/60",
                    )}
                    style={{
                      width:
                        row.tierUtilisation === null
                          ? "0%"
                          : `${Math.min(row.tierUtilisation * 100, 100)}%`,
                    }}
                  />
                </div>
              </div>

              <div className="rounded-xl border bg-muted/20 p-4">
                <div className="flex items-center gap-2">
                  <Sigma className="size-3.5 text-blue-500" />
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Per-race ceiling
                  </p>
                </div>
                <p className="mt-1 text-2xl font-bold tabular-nums text-blue-600 dark:text-blue-400">
                  {formatCurrency(row.configuredBudget)}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Sum of race_prize_tiers per {TYPE_LABEL[row.raceType].toLowerCase()} race
                </p>
                <div className="mt-3 flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>Window ceiling</span>
                  <span className="tabular-nums">
                    {formatCurrency(row.tierBudgetForWindow)}
                  </span>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
