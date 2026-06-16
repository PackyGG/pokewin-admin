import { Users } from "lucide-react";
import {
  getCohortRetention,
  type CohortGranularity,
} from "@/lib/queries/analytics-cohorts";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { FadeIn } from "@/components/fade-in";
import { compareAnalyticsCohorts } from "@/lib/clickhouse/compare/analytics-cohorts-compare";
import { resolveAdminRead } from "@/lib/clickhouse/resolve-read";
import { getCohortRetentionFromClickHouse } from "@/lib/clickhouse/queries/analytics/cohorts";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
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
  const { data, error } = await safeQuery(
    () =>
      resolveAdminRead<Awaited<ReturnType<typeof getCohortRetention>>>(
        "analytics_cohorts",
        {
          pg: () => getCohortRetention(granularity),
          ch: async () =>
            getCohortRetentionFromClickHouse(
              granularity,
              await getExcludedUserIds(),
            ),
        },
      ),
    null,
    "analytics.cohorts",
    REWARD_QUERY_TIMEOUT_MS,
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="Cohort retention"
        hint="The cohort query failed — refresh to retry."
        size="panel"
      />
    );
  }

  // CQRS comparison-mode shadow read (fire-and-forget; served payload stays PG).
  void compareAnalyticsCohorts(granularity, data);

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
