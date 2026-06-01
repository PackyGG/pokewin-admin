import { LineChart as LineChartIcon, Globe2 } from "lucide-react";
import { SectionHeading } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { formatNumber } from "@/lib/utils/format";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { getSignupGeoTimeSeries } from "@/lib/queries/insights-rewards/signup/geo-timeseries";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { GeoTrendChart } from "./geo-trend-chart";

/**
 * Geo trend tab — top-5 countries' daily signup + claim trend over
 * the period.
 *
 * One country per panel (5 rows, stacked) so the per-country trend
 * is readable without overplotting. Each row's chart shows the daily
 * signup line (blue) and daily claim line (rose) — same colour
 * family as the Overview chart.
 */
export async function GeoTrendTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const { data, error } = await safeQuery(
    () => getSignupGeoTimeSeries(period),
    null,
    "insights-rewards-signup.geo-timeseries",
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="Signup — Geo trend"
        hint="The geo time-series query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }
  const label = insightsRewardsPeriodLabel(period);
  if (data.length === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Globe2}
          title={`No country signups in ${label.toLowerCase()}`}
          description="No signup activity in this window — geo trend is empty."
          compact
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="space-y-3">
          <SectionHeading
            icon={LineChartIcon}
            title={`Top 5 countries · signup + claim trend — ${label}`}
          />
          <div className="grid gap-3 lg:grid-cols-2">
            {data.map((c) => (
              <div
                key={c.code}
                className="surface-sheen relative overflow-hidden rounded-2xl border bg-card p-4"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      {c.code}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      · {formatNumber(c.signups)} signups · {formatNumber(c.claimers)} claimers
                    </span>
                  </div>
                </div>
                <div className="mt-3">
                  <GeoTrendChart daily={c.daily} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </FadeIn>
    </div>
  );
}
