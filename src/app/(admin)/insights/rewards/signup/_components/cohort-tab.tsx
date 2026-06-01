import { CalendarRange } from "lucide-react";
import { SectionHeading } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { formatDate, formatNumber } from "@/lib/utils/format";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { getSignupCohortMatrix } from "@/lib/queries/insights-rewards/signup/cohort-matrix";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";

/**
 * Cohort matrix tab — weekly signup cohorts × claim usage × 30d
 * retention.
 *
 * One row per cohort week with:
 *   - signups + claimers + claim rate
 *   - 30d retention overall + per cut (claimer / non-claimer)
 *   - "retentionWindowComplete" flag — true if the cohort is older
 *     than 30d, so the retention number is comparable; false → still
 *     an incomplete window, the cell is muted in the table.
 */
export async function CohortMatrixTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const { data: rows, error } = await safeQuery(
    () => getSignupCohortMatrix(period),
    null,
    "insights-rewards-signup.cohort-matrix",
  );
  if (error || !rows) {
    return (
      <TileErrorFallback
        label="Signup — Cohort matrix"
        hint="The cohort matrix query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }
  const label = insightsRewardsPeriodLabel(period);
  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={CalendarRange}
          title={`No cohort weeks in ${label.toLowerCase()}`}
          description="No signup activity in the window. Try a longer period."
          compact
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="space-y-3">
          <SectionHeading
            icon={CalendarRange}
            title={`Weekly cohort matrix — ${label}`}
          />
          <div className="surface-sheen relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
            <p className="text-[11px] text-muted-foreground">
              Each row is one ISO-week signup cohort (Monday-anchored).
              &ldquo;30d ret&rdquo; requires 30 days of post-signup history;
              cohorts still inside that window render greyed out.
              Capped at the last ~52 weeks for readability.
            </p>
            <div className="mt-3 overflow-x-auto">
              <div className="inline-block min-w-full">
                <div className="grid grid-cols-[110px_72px_72px_72px_84px_84px_84px] items-center gap-2 px-2 pb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <span>Week start</span>
                  <span className="text-right">Signups</span>
                  <span className="text-right">Claimers</span>
                  <span className="text-right">Claim %</span>
                  <span className="text-right">30d ret</span>
                  <span className="text-right">Claimer ret</span>
                  <span className="text-right">Non-cl ret</span>
                </div>
                <div className="space-y-1">
                  {rows.map((r) => {
                    const muted = !r.retentionWindowComplete;
                    return (
                      <div
                        key={r.week}
                        className="grid grid-cols-[110px_72px_72px_72px_84px_84px_84px] items-center gap-2 rounded-lg border bg-muted/20 px-2 py-2"
                      >
                        <span className="font-mono text-xs tabular-nums text-muted-foreground">
                          {formatDate(r.week)}
                        </span>
                        <span className="text-right text-sm tabular-nums">
                          {formatNumber(r.signups)}
                        </span>
                        <span className="text-right text-sm tabular-nums text-blue-600 dark:text-blue-400">
                          {formatNumber(r.claimers)}
                        </span>
                        <span className="text-right text-sm tabular-nums text-blue-600 dark:text-blue-400">
                          {(r.claimRate * 100).toFixed(1)}%
                        </span>
                        <span
                          className={
                            muted
                              ? "text-right text-sm tabular-nums text-muted-foreground"
                              : "text-right text-sm tabular-nums"
                          }
                        >
                          {(r.retained30dShare * 100).toFixed(1)}%
                        </span>
                        <span
                          className={
                            muted
                              ? "text-right text-sm tabular-nums text-muted-foreground/70"
                              : "text-right text-sm tabular-nums text-blue-600 dark:text-blue-400"
                          }
                        >
                          {(r.claimerRetained30dShare * 100).toFixed(1)}%
                        </span>
                        <span
                          className={
                            muted
                              ? "text-right text-sm tabular-nums text-muted-foreground/70"
                              : "text-right text-sm tabular-nums"
                          }
                        >
                          {(r.nonClaimerRetained30dShare * 100).toFixed(1)}%
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      </FadeIn>
    </div>
  );
}
