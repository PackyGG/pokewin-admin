import {
  Globe,
  Users,
  MapPinOff,
  TrendingUp,
  Swords,
} from "lucide-react";
import { getUsersByCountry } from "@/lib/queries/map";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { KpiTile, SectionHeading } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { MetricToggle } from "./map/metric-toggle";
import { WorldMap } from "./map/world-map";
import { CountryLeaderboard } from "./map/country-leaderboard";
import { ContinentBreakdown } from "./map/continent-breakdown";
import { type MapMetric } from "./map/utils";
import type { AnalyticsPeriod } from "./types";

/**
 * Map tab — geographic distribution of users + per-country money flows
 * for the period selected on the analytics hero.
 *
 * Migrated from the standalone /map page into an analytics tab so all
 * timeline-bounded views share a single hero / period filter / shell.
 * The map's own MetricToggle is rendered inside this tab (not in the
 * hero) since metric is map-specific and would clutter the shared
 * analytics chrome on tabs that don't use it.
 *
 * `getUsersByCountry`'s `Period` type matches `AnalyticsPeriod`
 * one-for-one (today | 7d | 30d | 90d | all), so no period mapping is
 * needed — we pass the hero period through directly.
 */
export async function MapTab({
  period,
  metric,
}: {
  period: AnalyticsPeriod;
  metric: MapMetric;
}) {
  const { data, error } = await safeQuery(
    () => getUsersByCountry(period),
    null,
    "analytics.map",
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="Geographic distribution"
        hint="The country breakdown query failed — refresh to retry."
        size="panel"
      />
    );
  }
  const topCountry = data.byCountry[0];

  // Platform-wide aggregates for the KPI strip. We roll up from the
  // per-country rows (staff already excluded by the query) so the
  // numbers here and on the map always match.
  const totals = data.byCountry.reduce(
    (acc, c) => ({
      deposits: acc.deposits + c.total_deposits,
      depositCount: acc.depositCount + c.deposit_count,
      wager: acc.wager + c.total_wager,
    }),
    { deposits: 0, depositCount: 0, wager: 0 },
  );
  const multiplier = totals.deposits > 0 ? totals.wager / totals.deposits : 0;

  return (
    <div className="space-y-6">
      {/* Metric selector — map-specific (users / deposits / wagers /
          multiplier) so it lives inside the tab, not on the shared
          hero. Aligned right at sm+ so it sits beside the section
          heading like other in-tab controls. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-muted-foreground">
          Where users live, deposit, and wager — across{" "}
          {data.byCountry.length}{" "}
          countr{data.byCountry.length === 1 ? "y" : "ies"}.
        </div>
        <MetricToggle />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <KpiTile
          label="Total Users"
          value={formatNumber(data.totalUsers)}
          sub={
            topCountry
              ? `Top: ${topCountry.country ?? topCountry.country_code.toUpperCase()} · ${formatNumber(topCountry.user_count)}`
              : `${data.byCountry.length} countries`
          }
          icon={Users}
          accent="blue"
        />
        <KpiTile
          label="Deposits"
          value={formatCurrency(totals.deposits)}
          sub={`${formatNumber(totals.depositCount)} transactions`}
          icon={TrendingUp}
          accent="emerald"
        />
        <KpiTile
          label="Total Wagers"
          value={formatCurrency(totals.wager)}
          sub={
            multiplier > 0
              ? `${multiplier.toFixed(2)}× per $ deposited`
              : "No wager activity"
          }
          icon={Swords}
          accent="cyan"
        />
        <KpiTile
          label="Without Location"
          value={formatNumber(data.withoutLocation)}
          sub="Users with no country data"
          icon={MapPinOff}
          accent="orange"
        />
      </div>

      <FadeIn>
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <div className="space-y-2">
              <SectionHeading icon={Globe} title="Global distribution" />
              <WorldMap data={data.byCountry} metric={metric} />
            </div>
          </div>
          <CountryLeaderboard data={data.byCountry} metric={metric} />
        </div>
      </FadeIn>

      <FadeIn delay={120}>
        <ContinentBreakdown data={data.byCountry} metric={metric} />
      </FadeIn>
    </div>
  );
}
