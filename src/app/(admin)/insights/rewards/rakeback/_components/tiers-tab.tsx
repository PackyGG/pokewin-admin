import { Layers, BarChart3 } from "lucide-react";
import { SectionHeading, StatPanel, PanelRow } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { getRakebackExtras } from "@/lib/queries/rewards-category-extras";
import {
  insightsPeriodToCategoryPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { DistributionBarChart } from "@/app/(admin)/rewards/analytics/_components/distribution-bar-chart";

/**
 * Tier-spread tab. Re-uses the existing `getRakebackExtras` helper from
 * `rewards-category-extras.ts` so the breakdown reconciles with the
 * Rakeback tab on /rewards/analytics (same period → same numbers by
 * construction).
 *
 * Slices total rakeback by `rakeback_type` (daily / weekly / monthly):
 *   - claim count per type
 *   - USD volume per type
 *   - % share of total
 *
 * House-POV: each tier is part of the same rakeback cost → rose.
 *
 * Period note: the per-category helper exposes today / 7d / 30d / all,
 * so the wider insights periods round to the closest supported bucket
 * (24h → today, 3d → 7d, 90d → 30d). The page footer mentions this so
 * admins know why the numbers might not match the page's own headline
 * for the same nominal window.
 */
export async function TiersTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const categoryPeriod = insightsPeriodToCategoryPeriod(period);
  const extrasRes = await safeQuery(
    () => getRakebackExtras(categoryPeriod),
    null,
    "insights-rewards-rakeback.tiers",
  );
  if (extrasRes.error || !extrasRes.data) {
    return (
      <TileErrorFallback
        label="Rakeback — Tier spread"
        hint="The tier-spread query failed."
        size="panel"
      />
    );
  }
  const extras = extrasRes.data;
  const spread = extras.rakebackTypeSpread;
  const totalVolume = spread.reduce((acc, t) => acc + t.volume, 0);
  const totalCount = spread.reduce((acc, t) => acc + t.count, 0);

  if (totalCount === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Layers}
          title="No tiered rakeback claims in this window"
          description="No daily / weekly / monthly claims landed in the selected period."
          compact
        />
      </div>
    );
  }

  const chartData = spread.map((t) => ({
    label: capitalise(t.type),
    count: t.count,
    volume: t.volume,
  }));

  return (
    <div className="space-y-6">
      <FadeIn>
        <SectionHeading
          icon={BarChart3}
          title="Claim volume by tier (USD)"
        />
        <div className="mt-3 rounded-2xl border bg-card p-4 sm:p-5">
          <DistributionBarChart data={chartData} metric="volume" height={220} />
        </div>
      </FadeIn>

      <FadeIn>
        <div className="grid gap-3 sm:grid-cols-3">
          {spread.map((t) => (
            <StatPanel
              key={t.type}
              title={capitalise(t.type)}
              icon={Layers}
              accent="rose"
            >
              <p className="text-2xl font-bold leading-tight tracking-tight tabular-nums text-rose-600 dark:text-rose-400 sm:text-3xl">
                {formatCurrency(t.volume)}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {formatNumber(t.count)} claims · {t.share.toFixed(1)}% of total
              </p>
              <div className="mt-3 space-y-0.5 border-t pt-3 text-sm">
                <PanelRow
                  label="Avg per claim"
                  value={formatCurrency(
                    t.count > 0 ? t.volume / t.count : 0,
                  )}
                />
                <PanelRow
                  label="Share of count"
                  value={
                    totalCount > 0
                      ? `${((t.count / totalCount) * 100).toFixed(1)}%`
                      : "—"
                  }
                />
                <PanelRow
                  label="Share of $"
                  value={
                    totalVolume > 0
                      ? `${((t.volume / totalVolume) * 100).toFixed(1)}%`
                      : "—"
                  }
                />
              </div>
            </StatPanel>
          ))}
        </div>
      </FadeIn>

      <p className="text-[11px] text-muted-foreground">
        Tier numbers come from the shared per-category helper which buckets
        windows into today / 7d / 30d / all-time. Wider insights periods
        round to the closest bucket; the headline KPI strip on Overview
        uses the page-native window.
      </p>
    </div>
  );
}

function capitalise(s: string): string {
  return s.length === 0 ? s : `${s[0].toUpperCase()}${s.slice(1)}`;
}
