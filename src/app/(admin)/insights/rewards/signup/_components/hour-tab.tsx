import { Sun, CalendarDays } from "lucide-react";
import { SectionHeading } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { formatNumber } from "@/lib/utils/format";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { getSignupHourOfDay } from "@/lib/queries/insights-rewards/signup/hour-of-day";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { DistributionBarChart } from "@/app/(admin)/rewards/analytics/_components/distribution-bar-chart";
import { HeatmapGrid } from "./heatmap-grid";

/**
 * Hour-of-day tab — temporal patterns for cohort claim events.
 *
 * Two charts (24-bin hourly + 7-bin day-of-week) above a 7×24 heatmap
 * for the at-a-glance "when do claims spike" read. Bins are UTC for
 * consistency with the rest of the admin dashboard.
 */
export async function HourTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const { data, error } = await safeQuery(
    () => getSignupHourOfDay(period),
    null,
    "insights-rewards-signup.hour",
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="Signup — Hour-of-day"
        hint="The hour-of-day query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }
  const label = insightsRewardsPeriodLabel(period);
  const totalClaims = data.hourly.reduce((a, b) => a + b.count, 0);

  if (totalClaims === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Sun}
          title={`No claim activity in ${label.toLowerCase()}`}
          description="No cohort users claimed in this window — temporal pattern is empty."
          compact
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="grid gap-4 xl:grid-cols-2">
          <div className="space-y-3">
            <SectionHeading icon={Sun} title={`Hour of day (UTC) — ${label}`} />
            <div className="surface-sheen relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
              <p className="text-[11px] text-muted-foreground">
                Claim count per hour. Spotting the spike helps ops
                schedule live moderation / event drops.
              </p>
              <div className="mt-3">
                <DistributionBarChart
                  data={data.hourly}
                  metric="count"
                  height={220}
                />
              </div>
            </div>
          </div>
          <div className="space-y-3">
            <SectionHeading icon={CalendarDays} title={`Day of week — ${label}`} />
            <div className="surface-sheen relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
              <p className="text-[11px] text-muted-foreground">
                Claim count per day of week. 0=Sun … 6=Sat.
              </p>
              <div className="mt-3">
                <DistributionBarChart
                  data={data.dayOfWeek.map((d) => ({
                    label: d.label,
                    count: d.count,
                    volume: d.volume,
                  }))}
                  metric="count"
                  height={220}
                />
              </div>
            </div>
          </div>
        </div>
      </FadeIn>

      <FadeIn>
        <div className="space-y-3">
          <SectionHeading icon={CalendarDays} title="Heatmap — day × hour" />
          <div className="surface-sheen relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
            <p className="text-[11px] text-muted-foreground">
              7 days × 24 hours = 168 cells. Darker rose → more claim
              events in that cell. {formatNumber(totalClaims)} total claims.
            </p>
            <div className="mt-3">
              <HeatmapGrid cells={data.heatmap} />
            </div>
          </div>
        </div>
      </FadeIn>
    </div>
  );
}
