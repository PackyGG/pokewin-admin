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
    <div className="mx-auto w-full max-w-[1600px] space-y-5">
      <PageHero>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <PageHeroIdentity
            icon={SlidersHorizontal}
            accent="cyan"
            title="System Edge Plan"
            subtitle="Model house edge, rewards, and pack EVs with live pack previews — read-only planning on real production data."
          />
          <SystemEdgePeriodFilter />
        </div>
      </PageHero>

      <p className="text-xs text-muted-foreground">
        Baseline window:{" "}
        <span className="font-medium text-foreground">
          {insightsRewardsPeriodLabel(period)}
        </span>
        . Move any lever to see projected GGR, NGR, and profit delta vs live config.
      </p>

      <Suspense key={period} fallback={<SystemEdgePlanSkeleton />}>
        <SystemEdgePlanContent period={period} />
      </Suspense>
    </div>
  );
}
