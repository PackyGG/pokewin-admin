import { Suspense } from "react";
import { LineChart } from "lucide-react";

import { requirePageAccess } from "@/lib/dal";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import {
  parseInsightsRewardsPeriod,
  insightsRewardsPeriodLabel,
} from "@/lib/queries/insights-rewards/_period";

import { ForecastPeriodFilter, ForecastRewardPicker } from "./_controls";
import {
  FORECAST_REWARDS,
  resolveForecastReward,
} from "./_registry";
import { ForecastHubSkeleton } from "./_skeleton";

export const metadata = { title: "Reward Forecast" };

/**
 * /insights/forecast — the UNIFIED reward-forecast hub.
 *
 * One surface that hosts a FULL-DEPTH forecast per reward type, each modeled on
 * the deposit-bonus reference. A reward is selected via `?reward=` (with the
 * timeframe via `?period=`); the selected reward's forecast is mounted lazily in
 * its own `<Suspense key={`${reward}:${period}`}>` boundary, so ONLY that
 * reward's real-baseline query fires on the initial render (active-timeframe-
 * only, per CLAUDE.md — no eager loading of the other rewards).
 *
 * The reward set is driven entirely by `_registry.tsx`; adding a reward there
 * adds it to the picker + makes it mountable here with zero page changes.
 *
 * House-POV throughout (the shared simulator enforces it): rewards paid out are
 * a house cost → rose; savings against the house → emerald; abuse → amber.
 */
export default async function ForecastHubPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/insights/forecast");
  const params = await searchParams;
  const period = parseInsightsRewardsPeriod(params.period);
  const reward = resolveForecastReward(params.reward);
  const RewardForecast = reward.component;

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <PageHeroIdentity
            icon={LineChart}
            accent="cyan"
            title="Reward Forecast"
            subtitle="Model every reward program before you ship a change — scenario simulation anchored on real production baselines."
          />
          <div className="flex flex-wrap items-center gap-2">
            <ForecastPeriodFilter />
          </div>
        </div>
      </PageHero>

      {/* ── Reward picker ─────────────────────────────────────────── */}
      <div className="space-y-2">
        <ForecastRewardPicker
          rewards={FORECAST_REWARDS.map((r) => ({
            key: r.key,
            label: r.label,
            accent: r.accent,
          }))}
          active={reward.key}
        />
        <p className="text-xs text-muted-foreground">
          {reward.blurb} · Baseline: {insightsRewardsPeriodLabel(period)}.
        </p>
      </div>

      {/* ── Active reward forecast (lazy, active-timeframe-only) ───── */}
      <Suspense key={`${reward.key}:${period}`} fallback={<ForecastHubSkeleton />}>
        <RewardForecast period={period} />
      </Suspense>
    </div>
  );
}
