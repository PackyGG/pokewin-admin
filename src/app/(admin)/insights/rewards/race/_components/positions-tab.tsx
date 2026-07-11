import { Crosshair, PieChart } from "lucide-react";
import { SectionHeading } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { safeQuery } from "@/lib/errors/safe-query";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { getRaceInsightsPositions } from "@/lib/queries/insights-rewards/race/positions";
import { compareRacePositions } from "@/lib/clickhouse/compare/insights-race-positions";
import { DistributionBarChart } from "@/app/(admin)/rewards/analytics/_components/distribution-bar-chart";

/**
 * Winner position distribution tab on /insights/rewards/race.
 * Reuses the existing DistributionBarChart so the visual reads as one
 * family with the sibling /rewards/analytics race tab.
 *
 * House-POV: every bucket is house cost → rose.
 */
export async function RacePositionsTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const res = await safeQuery(
    () => getRaceInsightsPositions(period),
    [],
    "insights-rewards.race.positions",
  );
  if (res.error) {
    return (
      <TileErrorFallback
        label="Race — Positions"
        hint="The position-distribution query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }
  const buckets = res.data;
  const label = insightsRewardsPeriodLabel(period);

  void compareRacePositions(period, buckets);

  const totalCount = buckets.reduce((acc, b) => acc + b.count, 0);
  const totalVolume = buckets.reduce((acc, b) => acc + b.volume, 0);

  if (totalCount === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Crosshair}
          title={`No prize positions in ${label.toLowerCase()}`}
          description="No race prizes claimed in this window. Try a longer period."
          compact
        />
      </div>
    );
  }

  return (
    <FadeIn>
      <div className="space-y-6">
        <div className="grid gap-4 xl:grid-cols-2">
          <div className="space-y-3">
            <SectionHeading icon={PieChart} title="Position distribution — by count" />
            <div className="relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
              <p className="text-[11px] text-muted-foreground">
                Number of prize lines per position bucket. A lopsided distribution
                toward the top buckets means races skew top-heavy.
              </p>
              <div className="mt-3">
                <DistributionBarChart data={buckets} metric="count" />
              </div>
            </div>
          </div>
          <div className="space-y-3">
            <SectionHeading icon={PieChart} title="Position distribution — by volume" />
            <div className="relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
              <p className="text-[11px] text-muted-foreground">
                Total prize $ paid per position bucket. Shows where the bulk of
                spend actually lands.
              </p>
              <div className="mt-3">
                <DistributionBarChart data={buckets} metric="volume" />
              </div>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {buckets.map((b) => {
            const sharePct = totalCount > 0 ? (b.count / totalCount) * 100 : 0;
            const volSharePct =
              totalVolume > 0 ? (b.volume / totalVolume) * 100 : 0;
            return (
              <div
                key={b.label}
                className="rounded-xl border bg-muted/20 p-3"
              >
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {b.label}
                </p>
                <p className="mt-0.5 text-base font-bold tabular-nums">
                  {formatNumber(b.count)}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {sharePct.toFixed(1)}% of prizes
                </p>
                <div className="mt-2 border-t pt-2">
                  <p className="text-sm font-medium tabular-nums text-rose-600 dark:text-rose-400">
                    {formatCurrency(b.volume)}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    {volSharePct.toFixed(1)}% of volume
                  </p>
                  <p className="text-[10px] tabular-nums text-muted-foreground">
                    Avg {formatCurrency(b.avgPrize)}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </FadeIn>
  );
}
