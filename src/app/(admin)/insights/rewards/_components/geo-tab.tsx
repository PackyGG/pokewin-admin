import {
  Globe2,
  Users,
  TrendingDown,
} from "lucide-react";
import {
  SectionHeading,
  KpiTile,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import {
  getRewardsGeoSourceBreakdown,
  type GeoSourceRow,
} from "@/lib/queries/insights-rewards/geo-source";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";

/**
 * Geo / Source tab — distribution of reward spend by country and
 * signup-source provider.
 *
 * Two side-by-side panels:
 *   - Top countries by total reward $ (top 12 + share bars)
 *   - Top signup sources by total reward $ (top 10 + share bars)
 *
 * House-POV: rose accent on all amounts (rewards = house cost).
 */
export async function GeoTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const { data, error } = await safeQuery(
    () => getRewardsGeoSourceBreakdown(period),
    null,
    "insights-rewards.geo",
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="Rewards — Geo / Source"
        hint="The geo-source query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }
  const label = insightsRewardsPeriodLabel(period);
  const totalCountryUsers = data.countries.reduce(
    (a, r) => a + r.userCount,
    0,
  );
  const totalSourceUsers = data.sources.reduce(
    (a, r) => a + r.userCount,
    0,
  );

  if (data.totalRewardCost === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Globe2}
          title={`No reward distribution in ${label.toLowerCase()}`}
          description="No reward payouts in this window — geo / source breakdown skipped."
          compact
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <KpiTile
            label="Total reward $ (window)"
            value={formatCurrency(data.totalRewardCost)}
            sub={label}
            icon={TrendingDown}
            accent="rose"
          />
          <KpiTile
            label="Top countries"
            value={`${data.countries.length}`}
            sub={`${formatNumber(totalCountryUsers)} users (top ${data.countries.length})`}
            icon={Globe2}
            accent="blue"
          />
          <KpiTile
            label="Top sources"
            value={`${data.sources.length}`}
            sub={`${formatNumber(totalSourceUsers)} users (top ${data.sources.length})`}
            icon={Users}
            accent="blue"
          />
          <KpiTile
            label="#1 country share"
            value={
              data.countries[0]
                ? `${data.countries[0].share.toFixed(1)}%`
                : "—"
            }
            sub={data.countries[0]?.label ?? "—"}
            icon={Globe2}
            accent="rose"
          />
        </div>
      </FadeIn>

      <FadeIn>
        <div className="grid gap-4 xl:grid-cols-2">
          <div>
            <SectionHeading icon={Globe2} title="By country" />
            <div className="mt-3">
              <DistributionPanel rows={data.countries} unitLabel="country" />
            </div>
          </div>
          <div>
            <SectionHeading icon={Users} title="By signup source" />
            <div className="mt-3">
              <DistributionPanel rows={data.sources} unitLabel="source" />
            </div>
          </div>
        </div>
      </FadeIn>
    </div>
  );
}

function DistributionPanel({
  rows,
  unitLabel,
}: {
  rows: GeoSourceRow[];
  unitLabel: string;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Globe2}
          title={`No ${unitLabel} data`}
          description={`No reward $ distributed by ${unitLabel} in this window.`}
          compact
        />
      </div>
    );
  }
  return (
    <div className="space-y-2 rounded-2xl border bg-card p-4 sm:p-5">
      {rows.map((row) => (
        <div key={row.key} className="rounded-lg border bg-muted/20 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium">{row.label}</span>
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                · {formatNumber(row.userCount)} users
              </span>
            </div>
            <span className="shrink-0 text-sm font-medium tabular-nums text-rose-600 dark:text-rose-400">
              {formatCurrency(row.total)}
            </span>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <div className="h-2 flex-1 overflow-hidden rounded-sm bg-muted">
              <div
                className="h-full rounded-sm bg-rose-500/60 transition-all"
                style={{ width: `${row.share}%` }}
              />
            </div>
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {row.share.toFixed(1)}%
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
