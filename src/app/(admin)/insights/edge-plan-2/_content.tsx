import { Sparkles } from "lucide-react";

import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";

import { getEdgePlanV2Baseline } from "./_baseline-v2";
import { EdgePlanV2Planner } from "./_planner/planner-shell";

export async function EdgePlanV2Content({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const baseline = await getEdgePlanV2Baseline(period);

  if (baseline.wager <= 0) {
    return (
      <div className="rounded-2xl border border-dashed bg-muted/20 p-10 text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-xl border border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-400">
          <Sparkles className="size-6" />
        </div>
        <p className="mt-4 text-sm font-semibold">
          No gameplay to anchor on for this period
        </p>
        <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
          Edge Plan 2.0 anchors on real production wager and reward cost (
          {insightsRewardsPeriodLabel(period)}). Pick a wider period above.
        </p>
      </div>
    );
  }

  return <EdgePlanV2Planner baseline={baseline} />;
}
