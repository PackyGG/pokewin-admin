import { Clock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { FadeIn } from "@/components/fade-in";
import {
  getActivityHeatmap,
  type HeatmapPeriod,
} from "@/lib/queries/analytics-heatmap";
import { compareAnalyticsHeatmap } from "@/lib/clickhouse/compare/analytics-heatmap-compare";
import { resolveAdminRead } from "@/lib/clickhouse/resolve-read";
import { getActivityHeatmapFromClickHouse } from "@/lib/clickhouse/queries/analytics/heatmap";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { HeatmapGrid } from "./heatmap-grid";
import type { AnalyticsPeriod } from "./types";

/**
 * 7×24 hour-of-week heatmap. Reveals weekly activity patterns (e.g.
 * payday Fridays spike). Metric toggle (wager vs deposit count) lives
 * inside the grid component so it can own the URL param.
 */
export async function HeatmapTab({
  period: heroPeriod,
}: {
  period: AnalyticsPeriod;
}) {
  const period: HeatmapPeriod =
    heroPeriod === "today"
      ? "7d"
      : heroPeriod === "7d" ||
          heroPeriod === "30d" ||
          heroPeriod === "90d" ||
          heroPeriod === "all"
        ? heroPeriod
        : "30d";
  const { data, error } = await safeQuery(
    () =>
      resolveAdminRead<Awaited<ReturnType<typeof getActivityHeatmap>>>(
        "analytics_heatmap",
        {
          pg: () => getActivityHeatmap(period),
          ch: async () =>
            getActivityHeatmapFromClickHouse(period, await getExcludedUserIds()),
        },
      ),
    null,
    "analytics.heatmap",
    REWARD_QUERY_TIMEOUT_MS,
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="Activity heatmap"
        hint="The heatmap query failed — refresh to retry."
        size="panel"
      />
    );
  }

  // CQRS comparison-mode shadow read (fire-and-forget; served payload stays PG).
  void compareAnalyticsHeatmap(period, data);

  return (
    <FadeIn>
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-xl border bg-muted/20 p-4">
          <div className="rounded-md bg-primary/10 p-1.5">
            <Clock className="size-4 text-primary" />
          </div>
          <div className="text-sm">
            <h3 className="font-semibold">Activity heatmap</h3>
            <p className="text-muted-foreground">
              When are users most active? 7 rows × 24 columns = one cell
              per hour-of-week. Use the metric toggle to switch between
              wager volume ($) and deposit count. Patterns to look for:
              weekend evening peaks, payday Friday spikes, overnight
              lulls.
            </p>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">
              Weekly activity pattern — {periodLabel(period)}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <HeatmapGrid data={data} />
          </CardContent>
        </Card>
      </div>
    </FadeIn>
  );
}

function periodLabel(p: HeatmapPeriod): string {
  switch (p) {
    case "7d":
      return "Last 7 days";
    case "30d":
      return "Last 30 days";
    case "90d":
      return "Last 90 days";
    case "all":
      return "Last 180 days (capped)";
  }
}
