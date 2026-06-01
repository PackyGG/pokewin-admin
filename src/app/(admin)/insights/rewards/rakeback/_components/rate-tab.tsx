import { Percent, Users, BarChart3 } from "lucide-react";
import { SectionHeading, KpiTile } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { formatNumber } from "@/lib/utils/format";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { getRakebackRateDistribution } from "@/lib/queries/insights-rewards/rakeback/rate-distribution";
import { type InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import { DistributionBarChart } from "@/app/(admin)/rewards/analytics/_components/distribution-bar-chart";

/**
 * "% of wager" tab. Per-CLAIMANT cohort lens:
 *   - Avg (volume-weighted) % of wager.
 *   - Median + p95 across per-user ratios.
 *   - Distribution histogram in five buckets (0–1, 1–3, 3–5, 5–10, 10%+).
 *
 * Rakeback is a payout from the house → rose tiles. The histogram is
 * count-based (claimants per bucket) so admins can see how concentrated
 * the cohort is around the configured tier rates.
 */
export async function RateTab({ period }: { period: InsightsRewardsPeriod }) {
  const distRes = await safeQuery(
    () => getRakebackRateDistribution(period),
    null,
    "insights-rewards-rakeback.rate",
  );
  if (distRes.error || !distRes.data) {
    return (
      <TileErrorFallback
        label="Rakeback — % of wager"
        hint="The rate distribution query failed."
        size="panel"
      />
    );
  }
  const dist = distRes.data;
  if (dist.cohortSize === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Percent}
          title="No claimants with attributed wager"
          description="No rakeback claims with a positive wagered amount in the selected window."
          compact
        />
      </div>
    );
  }

  // DistributionBarChart expects { label, count, volume } — we don't
  // have a per-bucket volume here (the histogram counts CLAIMANTS, not
  // claims), so we pass count and zero volume and render in count mode.
  const chartData = dist.buckets.map((b) => ({
    label: b.label,
    count: b.count,
    volume: 0,
  }));

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KpiTile
            label="Avg % of wager"
            value={`${dist.avgPctOfWager.toFixed(2)}%`}
            sub="Volume-weighted SUM(rake) / SUM(wager)"
            icon={Percent}
            accent="rose"
          />
          <KpiTile
            label="Median per-user %"
            value={`${dist.medianPctOfWager.toFixed(2)}%`}
            sub="Middle claimant"
            icon={Percent}
            accent="rose"
          />
          <KpiTile
            label="p95 per-user %"
            value={`${dist.p95PctOfWager.toFixed(2)}%`}
            sub="95th percentile claimant"
            icon={Percent}
            accent="rose"
          />
          <KpiTile
            label="Cohort size"
            value={formatNumber(dist.cohortSize)}
            sub="Claimants with wager > 0"
            icon={Users}
            accent="blue"
          />
        </div>
      </FadeIn>

      <FadeIn>
        <SectionHeading
          icon={BarChart3}
          title="Distribution — claimants by rakeback ÷ wager"
        />
        <div className="mt-3 rounded-2xl border bg-card p-4 sm:p-5">
          <DistributionBarChart data={chartData} metric="count" height={260} />
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
            {dist.buckets.map((b) => (
              <div
                key={b.label}
                className="rounded-lg border bg-muted/20 px-2 py-1.5"
              >
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {b.label}
                </div>
                <div className="mt-0.5 tabular-nums text-foreground">
                  {formatNumber(b.count)}{" "}
                  <span className="text-[10px] text-muted-foreground">
                    · {b.share.toFixed(1)}%
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </FadeIn>
    </div>
  );
}
