import {
  TrendingDown,
  Users,
  Percent,
  LineChart as LineChartIcon,
  Hash,
  DollarSign,
  CircleDollarSign,
} from "lucide-react";
import { SectionHeading, KpiTile } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { getRakebackOverview } from "@/lib/queries/insights-rewards/rakeback/overview";
import { getRakebackDaily } from "@/lib/queries/insights-rewards/rakeback/daily";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { RakebackDailyChart } from "./daily-chart";
import { formatDeltaSub } from "./_format";

/**
 * Overview tab on /insights/rewards/rakeback. Top-line view:
 *
 *   - KPI strip: total rakeback paid, claimants, claim count, avg per
 *     claim, % of wager, largest single claim — each with period
 *     delta vs the prior-equal window.
 *   - Daily volume chart (rose area).
 *
 * House-POV: rakeback is house cost → rose accent. Period-over-period
 * deltas use the directional arrow without colouring (the tile picks
 * the accent — total cost = rose, claimants = blue).
 */
export async function OverviewTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const [overviewRes, dailyRes] = await Promise.all([
    safeQuery(
      () => getRakebackOverview(period),
      null,
      "insights-rewards-rakeback.overview",
    ),
    safeQuery(
      () => getRakebackDaily(period),
      [],
      "insights-rewards-rakeback.daily",
    ),
  ]);

  if (overviewRes.error || !overviewRes.data) {
    return (
      <TileErrorFallback
        label="Rakeback — Overview"
        hint="The rakeback overview query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }
  const overview = overviewRes.data;
  const daily = dailyRes.data;
  const label = insightsRewardsPeriodLabel(period);

  if (overview.count === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={TrendingDown}
          title={`No rakeback claims in ${label.toLowerCase()}`}
          description="No rakeback was claimed in the selected window. Try a longer period."
          compact
        />
      </div>
    );
  }

  const pctOfWager =
    overview.totalWager > 0
      ? (overview.totalRakeback / overview.totalWager) * 100
      : null;

  const costSub = formatDeltaSub(
    overview.priorWindow?.rakebackDelta ?? null,
    label,
  );
  const claimantSub = formatDeltaSub(
    overview.priorWindow?.claimantDelta ?? null,
    `${formatNumber(overview.count)} claims`,
  );
  const countSub = formatDeltaSub(
    overview.priorWindow?.countDelta ?? null,
    label,
  );

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <KpiTile
            label="Total rakeback"
            value={formatCurrency(overview.totalRakeback)}
            sub={costSub}
            icon={TrendingDown}
            accent="rose"
          />
          <KpiTile
            label="Active claimants"
            value={formatNumber(overview.distinctClaimants)}
            sub={claimantSub}
            icon={Users}
            accent="blue"
          />
          <KpiTile
            label="Claims"
            value={formatNumber(overview.count)}
            sub={countSub}
            icon={Hash}
            accent="rose"
          />
          <KpiTile
            label="Avg per claim"
            value={formatCurrency(overview.avgPerClaim)}
            sub="Rakeback ÷ claims"
            icon={DollarSign}
            accent="rose"
          />
          <KpiTile
            label="% of wager"
            value={pctOfWager === null ? "—" : `${pctOfWager.toFixed(2)}%`}
            sub={
              pctOfWager === null
                ? "No wager"
                : "Rakeback ÷ attributed wager"
            }
            icon={Percent}
            accent="rose"
          />
          <KpiTile
            label="Largest claim"
            value={formatCurrency(overview.largestClaim)}
            sub="Single biggest payout"
            icon={CircleDollarSign}
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
              title={`Daily rakeback — ${label}`}
            />
            <div className="mt-3">
              {dailyRes.error ? (
                <TileErrorFallback
                  label="Daily rakeback"
                  hint="The daily series failed to load."
                  size="compact"
                />
              ) : (
                <RakebackDailyChart daily={daily} />
              )}
            </div>
          </div>
        </div>
      </FadeIn>
    </div>
  );
}
