import {
  Activity,
  TrendingUp,
  Sparkles,
  UserMinus,
} from "lucide-react";
import { SectionHeading, KpiTile } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { formatNumber } from "@/lib/utils/format";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import {
  getSignupRetention,
  type RetentionCurveValue,
} from "@/lib/queries/insights-rewards/signup/retention";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { cn } from "@/lib/utils";

/**
 * Retention tab — claimer vs non-claimer cohort 24h / 7d / 30d
 * retention curves.
 *
 * "Active" = the cohort user made any wager or deposit ledger row
 * within X hours of signup. The lift % = (claimer share − non-claimer
 * share) / non-claimer share.
 *
 * House-POV:
 *   - retention is NEUTRAL → blue accents
 *   - positive lift (claimers retain BETTER) is rendered with a
 *     bluish-emerald tag — it isn't "house profit" so it doesn't get
 *     pure emerald, but it IS a useful positive product signal so the
 *     tag stands out
 *   - negative lift (claimers retain WORSE) is uncoloured / muted —
 *     informational, not alarming
 */
export async function RetentionTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const { data: ret, error } = await safeQuery(
    () => getSignupRetention(period),
    null,
    "insights-rewards-signup.retention",
  );
  if (error || !ret) {
    return (
      <TileErrorFallback
        label="Signup — Retention"
        hint="The retention query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }
  const label = insightsRewardsPeriodLabel(period);
  const totalCohort =
    ret.retention30d.claimerCount + ret.retention30d.nonClaimerCount;

  if (totalCohort === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Activity}
          title={`No cohort in ${label.toLowerCase()}`}
          description="No signups in this window so there's no retention to render."
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
            label="Cohort size"
            value={formatNumber(totalCohort)}
            sub={`${formatNumber(ret.retention30d.claimerCount)} claimers · ${formatNumber(ret.retention30d.nonClaimerCount)} non`}
            icon={Sparkles}
            accent="blue"
          />
          <KpiTile
            label="24h lift"
            value={
              ret.retention24h.liftPct === null
                ? "—"
                : `${ret.retention24h.liftPct >= 0 ? "+" : ""}${ret.retention24h.liftPct.toFixed(1)}%`
            }
            sub="Claimer vs non-claimer"
            icon={TrendingUp}
            accent="blue"
          />
          <KpiTile
            label="7d lift"
            value={
              ret.retention7d.liftPct === null
                ? "—"
                : `${ret.retention7d.liftPct >= 0 ? "+" : ""}${ret.retention7d.liftPct.toFixed(1)}%`
            }
            sub="Claimer vs non-claimer"
            icon={TrendingUp}
            accent="blue"
          />
          <KpiTile
            label="30d lift"
            value={
              ret.retention30d.liftPct === null
                ? "—"
                : `${ret.retention30d.liftPct >= 0 ? "+" : ""}${ret.retention30d.liftPct.toFixed(1)}%`
            }
            sub="Claimer vs non-claimer"
            icon={TrendingUp}
            accent="blue"
          />
        </div>
      </FadeIn>

      <FadeIn>
        <div className="space-y-3">
          <SectionHeading
            icon={Activity}
            title={`Retention curves — ${label}`}
          />
          <div className="surface-sheen relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
            <p className="text-[11px] text-muted-foreground">
              Share of cohort with any wager or deposit within X
              hours of signup. Claimers carried the signup-bonus claim;
              non-claimers signed up but skipped it. End-of-window
              cohort users may not have had time to be retained 30d
              — read the lifetime period for the cleanest read.
            </p>
            <div className="mt-3 space-y-3">
              <RetentionWindow
                label="24h"
                window={ret.retention24h}
              />
              <RetentionWindow label="7d" window={ret.retention7d} />
              <RetentionWindow label="30d" window={ret.retention30d} />
            </div>
          </div>
        </div>
      </FadeIn>
    </div>
  );
}

/**
 * Single-window retention row: claimer bar above, non-claimer bar
 * below, with the lift % to the right.
 */
function RetentionWindow({
  label,
  window: w,
}: {
  label: string;
  window: RetentionCurveValue;
}) {
  if (w.claimerCount === 0 && w.nonClaimerCount === 0) {
    return (
      <div className="rounded-lg border bg-muted/20 p-3">
        <div className="text-sm font-medium">{label} retention</div>
        <div className="mt-1 text-xs text-muted-foreground">
          No cohort data for this window.
        </div>
      </div>
    );
  }
  const liftLabel =
    w.liftPct === null
      ? "—"
      : `${w.liftPct >= 0 ? "+" : ""}${w.liftPct.toFixed(1)}%`;
  return (
    <div className="rounded-lg border bg-muted/20 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-medium">{label} retention</div>
        <div
          className={cn(
            "shrink-0 text-sm font-medium tabular-nums",
            w.liftPct != null && w.liftPct >= 0
              ? "text-blue-600 dark:text-blue-400"
              : "text-muted-foreground",
          )}
        >
          {liftLabel} lift
        </div>
      </div>

      <div className="mt-2 space-y-1.5">
        <div className="flex items-center gap-2">
          <div className="w-24 shrink-0 text-[11px] text-muted-foreground">
            <Sparkles className="mr-1 inline size-3 text-blue-500" />
            Claimers
          </div>
          <div className="h-2 flex-1 overflow-hidden rounded-sm bg-muted">
            <div
              className="h-full rounded-sm bg-blue-500/70 transition-all"
              style={{ width: `${w.claimerShare * 100}%` }}
            />
          </div>
          <div className="shrink-0 text-[11px] tabular-nums text-blue-600 dark:text-blue-400">
            {(w.claimerShare * 100).toFixed(1)}%
          </div>
          <div className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
            ({formatNumber(w.claimerRetained)}/{formatNumber(w.claimerCount)})
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-24 shrink-0 text-[11px] text-muted-foreground">
            <UserMinus className="mr-1 inline size-3 text-muted-foreground" />
            Non-claimers
          </div>
          <div className="h-2 flex-1 overflow-hidden rounded-sm bg-muted">
            <div
              className="h-full rounded-sm bg-muted-foreground/40 transition-all"
              style={{ width: `${w.nonClaimerShare * 100}%` }}
            />
          </div>
          <div className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {(w.nonClaimerShare * 100).toFixed(1)}%
          </div>
          <div className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
            ({formatNumber(w.nonClaimerRetained)}/{formatNumber(w.nonClaimerCount)})
          </div>
        </div>
      </div>
    </div>
  );
}
