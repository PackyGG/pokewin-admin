import { Users, Activity, CalendarRange } from "lucide-react";
import { SectionHeading, KpiTile } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { formatNumber } from "@/lib/utils/format";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { getRakebackActiveSubscribers } from "@/lib/queries/insights-rewards/rakeback/active-subscribers";
import { compareRakebackActive } from "@/lib/clickhouse/compare/insights-rakeback-active";
import { type InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import { cn } from "@/lib/utils";

/**
 * Active subscribers tab. Distinct claimants in window, weekly-active
 * series, and a cohort-retention matrix (week 0..3 since first claim).
 *
 * The retention table colours each cell by sharePct: brighter rose at
 * higher retention, faded at lower. House-POV: rakeback is cost — the
 * tile colour stays rose, but the matrix itself just uses opacity so
 * the eye reads concentration without the wrong P&L signal.
 */
export async function ActiveTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const activeRes = await safeQuery(
    () => getRakebackActiveSubscribers(period),
    null,
    "insights-rewards-rakeback.active",
  );
  if (activeRes.error || !activeRes.data) {
    return (
      <TileErrorFallback
        label="Rakeback — Active subscribers"
        hint="The active-subscriber query failed."
        size="panel"
      />
    );
  }
  const data = activeRes.data;
  void compareRakebackActive(period, data);
  if (data.distinctClaimants === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Users}
          title="No active rakeback subscribers"
          description="No claimants landed in the selected window. Try a longer period."
          compact
        />
      </div>
    );
  }

  // Avg weekly-active = mean of activeUsers across weeklyActive rows
  // when the series is non-empty.
  const avgWeekly =
    data.weeklyActive.length === 0
      ? 0
      : data.weeklyActive.reduce((acc, w) => acc + w.activeUsers, 0) /
        data.weeklyActive.length;

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <KpiTile
            label="Distinct claimants"
            value={formatNumber(data.distinctClaimants)}
            sub="In window"
            icon={Users}
            accent="blue"
          />
          <KpiTile
            label="Avg weekly active"
            value={data.weeklyActive.length === 0 ? "—" : avgWeekly.toFixed(0)}
            sub={
              data.weeklyActive.length === 0
                ? "No weekly data"
                : `${formatNumber(data.weeklyActive.length)} weeks observed`
            }
            icon={Activity}
            accent="blue"
          />
          <KpiTile
            label="Cohorts tracked"
            value={formatNumber(data.cohorts.length)}
            sub="Most recent shown"
            icon={CalendarRange}
            accent="blue"
          />
        </div>
      </FadeIn>

      <FadeIn>
        <SectionHeading icon={Activity} title="Weekly active rakebackers" />
        <div className="mt-3 overflow-hidden rounded-2xl border bg-card">
          <div className="grid grid-cols-[1fr_auto] gap-x-3 px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground sm:grid-cols-[1fr_auto_auto] sm:px-5">
            <span>Week</span>
            <span className="text-right">Active users</span>
          </div>
          <div className="max-h-72 overflow-y-auto">
            {data.weeklyActive.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                No weekly activity rows for this window.
              </div>
            ) : (
              [...data.weeklyActive].reverse().map((wk) => (
                <div
                  key={wk.weekStart}
                  className="grid grid-cols-[1fr_auto] gap-x-3 border-t border-border/40 px-4 py-2 text-sm sm:px-5"
                >
                  <span className="tabular-nums text-muted-foreground">
                    {wk.weekStart}
                  </span>
                  <span className="tabular-nums font-medium">
                    {formatNumber(wk.activeUsers)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </FadeIn>

      <FadeIn>
        <SectionHeading
          icon={CalendarRange}
          title="Cohort retention — share of cohort active by week since first claim"
        />
        <div className="mt-3 overflow-hidden rounded-2xl border bg-card">
          {data.cohorts.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              No cohorts to plot. Need at least one first-claim landing in this
              window.
            </div>
          ) : (
            <table className="w-full table-fixed text-sm">
              <thead className="bg-muted/30 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 text-left sm:px-5">Cohort</th>
                  <th className="px-3 py-2 text-right">Size</th>
                  <th className="px-3 py-2 text-center">W0</th>
                  <th className="px-3 py-2 text-center">W1</th>
                  <th className="px-3 py-2 text-center">W2</th>
                  <th className="px-3 py-2 text-center">W3</th>
                </tr>
              </thead>
              <tbody>
                {data.cohorts.map((c) => (
                  <tr key={c.cohortWeekStart} className="border-t border-border/40">
                    <td className="px-4 py-2 tabular-nums text-muted-foreground sm:px-5">
                      {c.cohortWeekStart}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium">
                      {formatNumber(c.cohortSize)}
                    </td>
                    {c.retention.map((cell) => (
                      <td
                        key={cell.weekOffset}
                        className="px-3 py-2 text-center"
                      >
                        <RetentionCell sharePct={cell.sharePct} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </FadeIn>
    </div>
  );
}

function RetentionCell({ sharePct }: { sharePct: number }) {
  // Opacity ramp from 0.08 (low) → 0.5 (high). 100% = full saturation.
  const clamped = Math.max(0, Math.min(100, sharePct));
  const opacity = 0.08 + (clamped / 100) * 0.42;
  return (
    <div
      className={cn(
        "mx-auto inline-flex min-w-[3.25rem] items-center justify-center rounded-md border px-2 py-1 text-xs tabular-nums",
        sharePct > 0
          ? "border-rose-500/30 text-rose-700 dark:text-rose-300"
          : "border-border text-muted-foreground",
      )}
      style={
        sharePct > 0
          ? { backgroundColor: `rgba(244, 63, 94, ${opacity.toFixed(3)})` }
          : undefined
      }
    >
      {sharePct === 0 ? "—" : `${sharePct.toFixed(0)}%`}
    </div>
  );
}
