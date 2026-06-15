import { Clock, Repeat, Users, BarChart3 } from "lucide-react";
import { SectionHeading, KpiTile } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { formatNumber } from "@/lib/utils/format";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { getRakebackCadence } from "@/lib/queries/insights-rewards/rakeback/cadence";
import { compareRakebackCadence } from "@/lib/clickhouse/compare/insights-rakeback-cadence";
import { type InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import { DistributionBarChart } from "@/app/(admin)/rewards/analytics/_components/distribution-bar-chart";
import { formatHours } from "./_format";

/**
 * Cadence tab. Time-between-claims distribution per user — bucketed into
 *
 *   < 1h / 1–24h / 1–7d / 7d+
 *
 * Plus avg claims per active user and median gap (across all gap rows).
 *
 * Rakeback is house cost → rose for the cost-related tiles. Active
 * claimants stay neutral blue.
 */
export async function CadenceTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const cadenceRes = await safeQuery(
    () => getRakebackCadence(period),
    null,
    "insights-rewards-rakeback.cadence",
  );
  if (cadenceRes.error || !cadenceRes.data) {
    return (
      <TileErrorFallback
        label="Rakeback — Cadence"
        hint="The cadence query failed."
        size="panel"
      />
    );
  }
  const cadence = cadenceRes.data;
  void compareRakebackCadence(period, cadence);
  if (cadence.totalClaims === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Clock}
          title="No rakeback claims to derive cadence"
          description="No claims landed in the selected window. Try a longer period."
          compact
        />
      </div>
    );
  }

  const chartData = cadence.buckets.map((b) => ({
    label: b.label,
    count: b.count,
    volume: 0,
  }));

  const totalGapRows = cadence.buckets.reduce((acc, b) => acc + b.count, 0);

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KpiTile
            label="Avg claims / user"
            value={cadence.avgClaimsPerActiveUser.toFixed(2)}
            sub={`${formatNumber(cadence.totalClaims)} claims ÷ ${formatNumber(cadence.distinctClaimants)} users`}
            icon={Repeat}
            accent="rose"
          />
          <KpiTile
            label="Active claimants"
            value={formatNumber(cadence.distinctClaimants)}
            sub="Distinct in window"
            icon={Users}
            accent="blue"
          />
          <KpiTile
            label="Median gap"
            value={formatHours(cadence.medianGapHours)}
            sub="Between consecutive claims"
            icon={Clock}
            accent="rose"
          />
          <KpiTile
            label="Gap samples"
            value={formatNumber(totalGapRows)}
            sub="One per user-to-user pair"
            icon={Clock}
            accent="rose"
          />
        </div>
      </FadeIn>

      <FadeIn>
        <SectionHeading icon={BarChart3} title="Gap distribution" />
        <div className="mt-3 rounded-2xl border bg-card p-4 sm:p-5">
          <DistributionBarChart data={chartData} metric="count" height={240} />
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            {cadence.buckets.map((b) => (
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
