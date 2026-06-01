import {
  TrendingDown,
  Flag,
  Users,
  Sigma,
  Trophy,
  LineChart as LineChartIcon,
  Hash,
} from "lucide-react";
import {
  KpiTile,
  SectionHeading,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { safeQuery } from "@/lib/errors/safe-query";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { getRaceInsightsOverview } from "@/lib/queries/insights-rewards/race/overview";
import { RaceDailyPrizeChart } from "./daily-prize-chart";

/**
 * Overview tab on /insights/rewards/race. Headline KPIs + daily prize
 * chart. House-POV: race prizes flow OUT to users → rose.
 */
export async function RaceOverviewTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const res = await safeQuery(
    () => getRaceInsightsOverview(period),
    null,
    "insights-rewards.race.overview",
  );
  if (res.error || !res.data) {
    return (
      <TileErrorFallback
        label="Race — Overview"
        hint="The race overview query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }
  const data = res.data;
  const label = insightsRewardsPeriodLabel(period);

  if (data.winnerCount === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Trophy}
          title={`No race prizes in ${label.toLowerCase()}`}
          description="No race prizes were paid in this window. Try a longer period."
          compact
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <KpiTile
            label="Total prize paid"
            value={formatCurrency(data.totalPrizePaid)}
            sub={`${formatNumber(data.winnerCount)} prize lines · ${label}`}
            icon={TrendingDown}
            accent="rose"
          />
          <KpiTile
            label="Distinct races"
            value={formatNumber(data.distinctRaces)}
            sub="Races with ≥1 winner"
            icon={Flag}
            accent="blue"
          />
          <KpiTile
            label="Distinct winners"
            value={formatNumber(data.distinctWinners)}
            sub="Unique users with a prize"
            icon={Users}
            accent="blue"
          />
          <KpiTile
            label="Avg prize / race"
            value={formatCurrency(data.avgPrizePerRace)}
            sub="Total prize / race count"
            icon={Sigma}
            accent="rose"
          />
          <KpiTile
            label="Avg prize / winner"
            value={formatCurrency(data.avgPrizePerWinner)}
            sub="Total prize / unique winners"
            icon={Sigma}
            accent="rose"
          />
          <KpiTile
            label="Prize lines"
            value={formatNumber(data.winnerCount)}
            sub="Total race_claims rows"
            icon={Hash}
            accent="rose"
          />
        </div>
      </FadeIn>

      <FadeIn>
        <div className="surface-sheen surface-raise relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/70 p-4 sm:p-5">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-12 -top-12 size-32 rounded-full bg-rose-500/[0.08] blur-2xl"
          />
          <div className="relative">
            <SectionHeading
              icon={LineChartIcon}
              title={`Daily prize payout — ${label}`}
            />
            <div className="mt-3">
              {data.dailyPrizes.length === 0 ? (
                <EmptyState
                  icon={LineChartIcon}
                  title="No daily data"
                  description="No claim activity yet for this window."
                  compact
                />
              ) : (
                <RaceDailyPrizeChart data={data.dailyPrizes} />
              )}
            </div>
          </div>
        </div>
      </FadeIn>
    </div>
  );
}
