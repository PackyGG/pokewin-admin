import {
  CalendarRange,
  Users,
  TrendingUp,
  Gift,
} from "lucide-react";
import {
  SectionHeading,
  KpiTile,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import {
  getRewardsCohortMatrix,
  type CohortRow,
} from "@/lib/queries/insights-rewards/cohort-matrix";
import { type InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";

/**
 * Cohort tab — signup cohort × reward usage × LTV.
 *
 * Buckets users by signup month (UTC, last 12 months). For each cohort
 * we render:
 *   - cohortSize       : distinct signups in that month
 *   - claimerShare     : % who claimed at least one reward (any time)
 *   - avgRewardPerUser : per-user reward cost across cohort
 *   - claimerLtv       : avg in-window gameplay GGR for claimers
 *   - nonClaimerLtv    : avg in-window GGR for non-claimers
 *   - liftPct          : (claimerLtv − nonClaimerLtv) / nonClaimerLtv
 *
 * Lifetime view by construction — the matrix is about cohort behaviour
 * across the user lifecycle, not point-in-time activity. The active
 * page period is accepted for API symmetry but ignored in the query.
 *
 * House-POV: claimer LTV emerald when positive, non-claimer LTV same
 * rule. Lift % emerald when positive (claimers carry more lifetime
 * GGR than non-claimers — i.e. our marketing spend is buying actual
 * downstream revenue).
 */
export async function CohortTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const data = await getRewardsCohortMatrix(period);
  const agg = data.aggregate;

  if (agg.cohortSize === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={CalendarRange}
          title="No cohort data"
          description="No signups in the trailing 12 months were detected — cohort matrix empty."
          compact
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Aggregate headline strip */}
      <FadeIn>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <KpiTile
            label="Cohort users (12 mo)"
            value={formatNumber(agg.cohortSize)}
            sub="Across last 12 months"
            icon={Users}
            accent="blue"
          />
          <KpiTile
            label="Claimer share"
            value={`${(agg.claimerShare * 100).toFixed(1)}%`}
            sub={`${formatNumber(agg.rewardClaimers)} claimers`}
            icon={Gift}
            accent="rose"
          />
          <KpiTile
            label="Avg reward / user"
            value={formatCurrency(agg.avgRewardPerUser)}
            sub="Cohort average"
            icon={Gift}
            accent="rose"
          />
          <KpiTile
            label="Claimer LTV (avg)"
            value={formatCurrency(agg.claimerLtv)}
            sub="Lifetime gameplay GGR"
            icon={TrendingUp}
            accent={agg.claimerLtv >= 0 ? "emerald" : "rose"}
          />
          <KpiTile
            label="Claimer LTV lift"
            value={
              agg.liftPct === null
                ? "—"
                : `${agg.liftPct >= 0 ? "+" : ""}${(agg.liftPct * 100).toFixed(0)}%`
            }
            sub="Vs non-claimer baseline"
            icon={TrendingUp}
            accent={
              agg.liftPct === null
                ? "blue"
                : agg.liftPct >= 0
                  ? "emerald"
                  : "rose"
            }
          />
        </div>
      </FadeIn>

      {/* Per-cohort table */}
      <FadeIn>
        <div className="space-y-3">
          <SectionHeading icon={CalendarRange} title="Cohort matrix" />
          <CohortTable rows={data.rows} />
        </div>
      </FadeIn>
    </div>
  );
}

function CohortTable({ rows }: { rows: CohortRow[] }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={CalendarRange}
        title="No cohort rows"
        description="No signup cohorts had observable activity in the matrix window."
        compact
      />
    );
  }
  return (
    <div className="overflow-x-auto rounded-2xl border bg-card">
      <div className="min-w-[760px]">
        <div className="grid grid-cols-[6rem_repeat(6,_minmax(0,_8rem))] gap-3 border-b border-border/60 bg-muted/30 px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          <span>Cohort</span>
          <span className="text-right">Users</span>
          <span className="text-right">Claimer share</span>
          <span className="text-right">Avg reward / user</span>
          <span className="text-right">Claimer LTV</span>
          <span className="text-right">Non-claimer LTV</span>
          <span className="text-right">Lift</span>
        </div>
        <ul>
          {rows.map((r) => {
            const claimerColor =
              r.claimerLtv >= 0
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-rose-600 dark:text-rose-400";
            const nonClaimerColor =
              r.nonClaimerLtv >= 0
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-rose-600 dark:text-rose-400";
            const liftColor =
              r.liftPct === null
                ? "text-muted-foreground"
                : r.liftPct >= 0
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-rose-600 dark:text-rose-400";
            return (
              <li
                key={r.cohort}
                className="grid grid-cols-[6rem_repeat(6,_minmax(0,_8rem))] items-center gap-3 border-b border-border/60 px-4 py-2.5 text-xs last:border-b-0"
              >
                <span className="truncate text-sm font-medium tabular-nums">
                  {r.cohort}
                </span>
                <span className="text-right tabular-nums text-muted-foreground">
                  {formatNumber(r.cohortSize)}
                </span>
                <span className="text-right tabular-nums">
                  {(r.claimerShare * 100).toFixed(1)}%
                </span>
                <span className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                  {formatCurrency(r.avgRewardPerUser)}
                </span>
                <span className={cn("text-right tabular-nums", claimerColor)}>
                  {formatCurrency(r.claimerLtv)}
                </span>
                <span className={cn("text-right tabular-nums", nonClaimerColor)}>
                  {formatCurrency(r.nonClaimerLtv)}
                </span>
                <span className={cn("text-right font-semibold tabular-nums", liftColor)}>
                  {r.liftPct === null
                    ? "—"
                    : `${r.liftPct >= 0 ? "+" : ""}${(r.liftPct * 100).toFixed(0)}%`}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
