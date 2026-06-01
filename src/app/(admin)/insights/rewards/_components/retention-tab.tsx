import {
  Activity,
  Users,
  CalendarDays,
  CalendarRange,
} from "lucide-react";
import {
  SectionHeading,
  KpiTile,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/utils/format";
import {
  getRewardsRetentionLift,
  type RetentionRow,
} from "@/lib/queries/insights-rewards/retention-lift";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";

/**
 * Retention tab — claimants vs non-claimants 7d / 30d retention.
 *
 * For each reward category, we compare:
 *   - cohort size       : how many in-window claimants
 *   - retain7d / 30d    : how many came back to wager in the 7d / 30d
 *                         windows after first claim
 *   - share7d / 30d     : retention rate
 *   - lift7d / 30d      : multiplicative lift vs non-claimant baseline
 *
 * The non-claimant baseline is users who were active in the same
 * window but had no reward of any kind. Anchor = first wager in the
 * window.
 *
 * House-POV: retention is a positive ledger for the house — more
 * retained users = more downstream wager. So positive lift renders
 * emerald; negative renders rose. This is one of the few places on
 * the page where the colour convention is "retained = good for us".
 */
export async function RetentionTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const data = await getRewardsRetentionLift(period);
  const label = insightsRewardsPeriodLabel(period);

  if (data.baseline.cohortSize === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Activity}
          title={`No baseline activity in ${label.toLowerCase()}`}
          description="No non-claimant baseline cohort detected for this window — retention lift cannot be computed."
          compact
        />
      </div>
    );
  }

  const allRowsZero = data.rows.every((r) => r.cohortSize === 0);

  return (
    <div className="space-y-6">
      {/* Headline strip — baseline cohort + retention shares. */}
      <FadeIn>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <KpiTile
            label="Baseline cohort"
            value={formatNumber(data.baseline.cohortSize)}
            sub="Non-claimants active in window"
            icon={Users}
            accent="blue"
          />
          <KpiTile
            label="Baseline 7d retain"
            value={`${(data.baseline.share7d * 100).toFixed(1)}%`}
            sub={`${formatNumber(data.baseline.retain7d)} returned`}
            icon={CalendarDays}
            accent="blue"
          />
          <KpiTile
            label="Baseline 30d retain"
            value={`${(data.baseline.share30d * 100).toFixed(1)}%`}
            sub={`${formatNumber(data.baseline.retain30d)} returned`}
            icon={CalendarRange}
            accent="blue"
          />
          <KpiTile
            label="Best 7d lift"
            value={bestLiftLabel(data.rows, "7d")}
            sub="Vs baseline"
            icon={Activity}
            accent="emerald"
          />
          <KpiTile
            label="Best 30d lift"
            value={bestLiftLabel(data.rows, "30d")}
            sub="Vs baseline"
            icon={Activity}
            accent="emerald"
          />
        </div>
      </FadeIn>

      {/* Per-category retention table */}
      <FadeIn>
        <div className="space-y-3">
          <SectionHeading icon={Activity} title="Per-category retention" />
          {allRowsZero ? (
            <EmptyState
              icon={Activity}
              title="No category claimants in this window"
              description="Categories had no claimant cohort to measure retention against."
              compact
            />
          ) : (
            <RetentionTable rows={data.rows} baseline={data.baseline} />
          )}
        </div>
      </FadeIn>
    </div>
  );
}

function bestLiftLabel(rows: RetentionRow[], bucket: "7d" | "30d"): string {
  const lifts = rows
    .map((r) => (bucket === "7d" ? r.lift7d : r.lift30d))
    .filter((v): v is number => v !== null);
  if (lifts.length === 0) return "—";
  const max = Math.max(...lifts);
  if (!Number.isFinite(max)) return "—";
  return `${max >= 0 ? "+" : ""}${(max * 100).toFixed(0)}%`;
}

function RetentionTable({
  rows,
  baseline,
}: {
  rows: RetentionRow[];
  baseline: RetentionRow;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border bg-card">
      <div className="grid grid-cols-[1.4fr_repeat(5,_minmax(0,_7rem))] gap-3 border-b border-border/60 bg-muted/30 px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <span>Category</span>
        <span className="text-right">Cohort</span>
        <span className="text-right">7d retain</span>
        <span className="text-right">7d lift</span>
        <span className="text-right">30d retain</span>
        <span className="text-right">30d lift</span>
      </div>
      <ul>
        {/* Baseline pinned at the top — gives admins an at-a-glance
            anchor against the per-category rows below. */}
        <RetentionRowEl row={baseline} isBaseline />
        {rows.map((r) => (
          <RetentionRowEl key={r.key} row={r} isBaseline={false} />
        ))}
      </ul>
    </div>
  );
}

function RetentionRowEl({
  row,
  isBaseline,
}: {
  row: RetentionRow;
  isBaseline: boolean;
}) {
  const liftColor = (lift: number | null) => {
    if (lift === null) return "text-muted-foreground";
    if (lift > 0) return "text-emerald-600 dark:text-emerald-400";
    if (lift < 0) return "text-rose-600 dark:text-rose-400";
    return "text-muted-foreground";
  };
  return (
    <li
      className={cn(
        "grid grid-cols-[1.4fr_repeat(5,_minmax(0,_7rem))] items-center gap-3 border-b border-border/60 px-4 py-2.5 text-xs last:border-b-0",
        isBaseline && "bg-muted/30 font-medium",
      )}
    >
      <span className="truncate text-sm font-medium">{row.label}</span>
      <span className="text-right tabular-nums text-muted-foreground">
        {formatNumber(row.cohortSize)}
      </span>
      <span className="text-right tabular-nums">
        {(row.share7d * 100).toFixed(1)}%
      </span>
      <span className={cn("text-right font-semibold tabular-nums", liftColor(row.lift7d))}>
        {row.lift7d === null
          ? "—"
          : `${row.lift7d >= 0 ? "+" : ""}${(row.lift7d * 100).toFixed(0)}%`}
      </span>
      <span className="text-right tabular-nums">
        {(row.share30d * 100).toFixed(1)}%
      </span>
      <span className={cn("text-right font-semibold tabular-nums", liftColor(row.lift30d))}>
        {row.lift30d === null
          ? "—"
          : `${row.lift30d >= 0 ? "+" : ""}${(row.lift30d * 100).toFixed(0)}%`}
      </span>
    </li>
  );
}
