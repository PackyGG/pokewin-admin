import { Clock } from "lucide-react";
import { FadeIn } from "@/components/fade-in";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  getInsightsHeatmap,
  parseHeatmapMetric,
} from "@/lib/queries/insights-analytics/heatmap";
import { InsightsHeatmapGrid } from "./insights-heatmap-grid";
import {
  INSIGHTS_PERIOD_LABELS,
  type InsightsPeriod,
} from "./types";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";

/**
 * Heatmap tab — 7×24 activity heatmap with 6 selectable metrics. The
 * grid component (client) owns the metric toggle so the URL stays in
 * sync without re-fetching (all 6 metrics are returned in one shot).
 */
export async function HeatmapInsightsTab({
  period,
  metric,
}: {
  period: InsightsPeriod;
  metric: string | undefined;
}) {
  const { data, error } = await safeQuery(
    () => getInsightsHeatmap(period),
    null,
    "insights-analytics.heatmap",
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="Analytics — Heatmap"
        hint="The heatmap query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }
  const initialMetric = parseHeatmapMetric(metric);

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
              When are users active? 7 rows × 24 columns = one cell per
              hour-of-week. Toggle between signups, deposits, withdrawals,
              wager, P&amp;L, and active users. House-POV: wager + P&amp;L
              are emerald, withdrawals are rose.
            </p>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">
              Weekly activity pattern — {INSIGHTS_PERIOD_LABELS[period]}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <InsightsHeatmapGrid data={data} initialMetric={initialMetric} />
          </CardContent>
        </Card>
      </div>
    </FadeIn>
  );
}
