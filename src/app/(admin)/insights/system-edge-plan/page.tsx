import { Suspense } from "react";
import { SlidersHorizontal } from "lucide-react";

import { requirePageAccess } from "@/lib/dal";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import {
  parseInsightsRewardsPeriod,
  insightsRewardsPeriodLabel,
} from "@/lib/queries/insights-rewards/_period";

import { SystemEdgePeriodFilter } from "./_period-filter";
import { SystemEdgePlanContent } from "./_content";
import { SystemEdgePlanSkeleton } from "./_skeleton";

export const metadata = { title: "System Edge Plan" };

/**
 * /insights/system-edge-plan — the full, customizable edge + reward-system
 * PLANNER. Plan future updates and see the projected PROFIT impact WITHOUT
 * touching any live data.
 *
 * The owner tunes EVERY system lever, grouped into sections:
 *   • House edge — SEPARATE per game type (packs · battles · upgrader).
 *   • Rakeback — per-cadence rates · pack/battle vs upgrader wager weighting ·
 *     an instant-claim payout-%/adoption control.
 *   • Deposit bonus — match % · cap · min deposit · wager requirement.
 *   • Raffle — prize pool · draw frequency · ticket cost.
 *   • Packs — daily/free pack value + frequency · signup grant.
 *   • Rain — net giveaway cost.
 *   • Affiliate — per-tier commission % + the 1× wager-requirement toggle.
 * …and sees the projected per-type GGR / reward COST / NGR / PROFIT, plus the
 * DELTA (savings / extra cost) vs the CURRENT live config, with monthly + annual
 * extrapolation.
 *
 * REAL config, never invented (CLAUDE.md + the discovery): the current config +
 * anchors all come from live production reads at request time — a per-type split
 * of the canonical gaming legs (packs/battles/upgrader, reconciling with the
 * headline GGR), `rakeback_config` (real daily/weekly/monthly rates),
 * `affiliate_level_configs` (real tier ladder), and the canonical metric layer
 * (`getWindowMetrics` + `sumLedgerTypes` + daily-packs + signup + net rain) for
 * real per-lever reward cost. Levers are seeded from those real values; the
 * projection scales the real baseline at the observed wager volume. Anything not
 * separable from real data in this snapshot is SURFACED but clearly labeled
 * (estimated / not yet wired) — never a fabricated number.
 *
 * Active-timeframe-only: the baseline for the selected `?period=` is fetched lazily
 * inside a keyed `<Suspense>` — switching the window swaps the boundary and fetches
 * ONLY that window. No eager preload of other periods.
 */
export default async function SystemEdgePlanPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/insights/system-edge-plan");
  const params = await searchParams;
  const period = parseInsightsRewardsPeriod(params.period);

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <PageHeroIdentity
            icon={SlidersHorizontal}
            accent="cyan"
            title="System Edge Plan"
            subtitle="Tune the reward-system levers and see the projected profit impact — read-only planning, anchored on real production config. No live data is changed."
          />
          <SystemEdgePeriodFilter />
        </div>
      </PageHero>

      <p className="text-xs text-muted-foreground">
        Anchored on real production wager, edge and reward cost over{" "}
        <span className="font-medium text-foreground">
          {insightsRewardsPeriodLabel(period)}
        </span>
        . Move a lever to see the projected GGR / NGR / profit and the delta vs the
        current live config.
      </p>

      {/* Active-timeframe-only: only the selected period's baseline is fetched. */}
      <Suspense key={period} fallback={<SystemEdgePlanSkeleton />}>
        <SystemEdgePlanContent period={period} />
      </Suspense>
    </div>
  );
}
