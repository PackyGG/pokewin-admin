import { Users, Globe2, Network, CalendarRange } from "lucide-react";
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
import {
  getRaceInsightsCohort,
  type RaceCohortRow,
} from "@/lib/queries/insights-rewards/race/cohort";
import { compareRaceCohort } from "@/lib/clickhouse/compare/insights-race-cohort";

/**
 * Cohort / Geo / Source tab for race winners on
 * /insights/rewards/race. Three side-by-side panels: country, signup
 * source, signup-recency cohort.
 *
 * House-POV: prize $ tags rose. Counts neutral.
 */
export async function RaceCohortTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const res = await safeQuery(
    () => getRaceInsightsCohort(period),
    null,
    "insights-rewards.race.cohort",
  );
  if (res.error || !res.data) {
    return (
      <TileErrorFallback
        label="Race — Cohort"
        hint="The cohort/geo query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }
  const data = res.data;
  const label = insightsRewardsPeriodLabel(period);

  void compareRaceCohort(period, data);

  const noActivity =
    data.countries.length === 0 &&
    data.sources.length === 0 &&
    data.signupCohorts.every((b) => b.winnerCount === 0);
  if (noActivity) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Users}
          title={`No winner demographics in ${label.toLowerCase()}`}
          description="No race winners in this window. Try a longer period."
          compact
        />
      </div>
    );
  }

  return (
    <FadeIn>
      <div className="grid gap-6 xl:grid-cols-3">
        <CohortPanel
          icon={Globe2}
          title="Top countries"
          subtitle="By prize volume"
          rows={data.countries}
          emptyHint="No country attribution."
        />
        <CohortPanel
          icon={Network}
          title="Signup sources"
          subtitle="By winner count"
          rows={data.sources}
          emptyHint="No signup source attribution."
        />
        <CohortPanel
          icon={CalendarRange}
          title="Signup recency"
          subtitle="Account age at first claim"
          rows={data.signupCohorts}
          emptyHint="No winners with signup data."
        />
      </div>
    </FadeIn>
  );
}

function CohortPanel({
  icon: Icon,
  title,
  subtitle,
  rows,
  emptyHint,
}: {
  icon: React.ElementType;
  title: string;
  subtitle: string;
  rows: RaceCohortRow[];
  emptyHint: string;
}) {
  const total = rows.reduce((acc, r) => acc + r.winnerCount, 0);
  return (
    <div className="space-y-3">
      <SectionHeading icon={Icon} title={title} />
      <div className="relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
        <p className="text-[11px] text-muted-foreground">{subtitle}</p>
        {total === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">{emptyHint}</p>
        ) : (
          <div className="mt-3 space-y-2">
            {rows.map((row) => (
              <div key={row.key} className="rounded-lg border bg-muted/20 p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate text-sm font-medium">
                    {row.label}
                  </span>
                  <span className="shrink-0 text-sm font-medium tabular-nums text-rose-600 dark:text-rose-400">
                    {formatCurrency(row.totalPrize)}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="tabular-nums">
                    {formatNumber(row.winnerCount)} winners
                  </span>
                  <span>·</span>
                  <span className="tabular-nums">
                    {row.share.toFixed(1)}%
                  </span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-sm bg-muted">
                  <div
                    className="h-full rounded-sm bg-rose-500/60 transition-all"
                    style={{ width: `${row.share}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
