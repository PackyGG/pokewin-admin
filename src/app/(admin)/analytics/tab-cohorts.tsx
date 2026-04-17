import { Users } from "lucide-react";
import {
  getCohortRetention,
  type CohortGranularity,
} from "@/lib/queries/analytics-cohorts";
import { FadeIn } from "@/components/fade-in";
import { CohortsHeatmap } from "./cohorts-heatmap";
import type { AnalyticsPeriod } from "./types";

/**
 * Signup-cohort retention analysis. The period filter in the page hero does
 * NOT apply here — cohort analysis only makes sense over a rolling horizon
 * rooted at the cohort's signup date. The grouping granularity (week /
 * month) is a separate control rendered inside the heatmap.
 */
export async function CohortsTab({
  period: _period,
  granularity,
}: {
  period: AnalyticsPeriod;
  granularity: CohortGranularity;
}) {
  void _period;
  const data = await getCohortRetention(granularity);

  return (
    <FadeIn>
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-xl border bg-muted/20 p-4">
          <div className="rounded-md bg-primary/10 p-1.5">
            <Users className="size-4 text-primary" />
          </div>
          <div className="text-sm">
            <h3 className="font-semibold">Cohort retention</h3>
            <p className="text-muted-foreground">
              Users are grouped by their signup {granularity}. Each column
              tracks how many of them were still wagering N {granularity}s
              later. Darker cell = stronger retention. The revenue grid
              shows the GGR those same users generated each period — monetary
              stickiness, not just login stickiness.
            </p>
          </div>
        </div>

        <CohortsHeatmap data={data} />
      </div>
    </FadeIn>
  );
}
