import { Globe2, MapPin } from "lucide-react";
import { SectionHeading } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { getRakebackGeoSource } from "@/lib/queries/insights-rewards/rakeback/geo-source";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";

/**
 * Geo + signup source breakdown for rakeback claimants. Two side-by-
 * side share-bar panels — country (ISO-2) and signup source (auth
 * provider). Both share the same window's `totalRakeback` denominator
 * so the share columns reconcile by construction.
 *
 * House-POV: rakeback paid → rose share bars.
 */
export async function GeoTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const geoRes = await safeQuery(
    () => getRakebackGeoSource(period),
    null,
    "insights-rewards-rakeback.geo",
  );
  if (geoRes.error || !geoRes.data) {
    return (
      <TileErrorFallback
        label="Rakeback — Geo / Source"
        hint="The geo / source query failed."
        size="panel"
      />
    );
  }
  const data = geoRes.data;
  const label = insightsRewardsPeriodLabel(period);

  if (data.totalRakeback === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Globe2}
          title={`No rakeback in ${label.toLowerCase()}`}
          description="No rakeback was claimed in the selected window."
          compact
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="grid gap-4 xl:grid-cols-2">
          <div>
            <SectionHeading icon={MapPin} title="By country" />
            <div className="mt-3">
              <BreakdownPanel
                rows={data.countries}
                emptyLabel="No country data"
              />
            </div>
          </div>
          <div>
            <SectionHeading icon={Globe2} title="By signup source" />
            <div className="mt-3">
              <BreakdownPanel
                rows={data.sources}
                emptyLabel="No signup source data"
              />
            </div>
          </div>
        </div>
      </FadeIn>
    </div>
  );
}

function BreakdownPanel({
  rows,
  emptyLabel,
}: {
  rows: Array<{
    key: string;
    label: string;
    userCount: number;
    total: number;
    share: number;
  }>;
  emptyLabel: string;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4 text-sm text-muted-foreground">
        {emptyLabel}
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
                style={{ width: `${Math.min(100, row.share)}%` }}
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
