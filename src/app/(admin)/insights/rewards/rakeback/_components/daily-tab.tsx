import { CalendarRange } from "lucide-react";
import { SectionHeading } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { getRakebackDaily } from "@/lib/queries/insights-rewards/rakeback/daily";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { RakebackDailyChart } from "./daily-chart";

/**
 * Daily breakdown tab. Per-day rows: claim count, rakeback volume,
 * avg per claim, distinct claimants.
 *
 * Chart sits above the table for quick visual scan; the table itself
 * stays scroll-bounded so 90d+ ranges don't push everything else off-
 * screen.
 *
 * House-POV: rakeback paid → rose volume column.
 */
export async function DailyTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const dailyRes = await safeQuery(
    () => getRakebackDaily(period),
    [],
    "insights-rewards-rakeback.daily-tab",
  );
  if (dailyRes.error) {
    return (
      <TileErrorFallback
        label="Rakeback — Daily"
        hint="The daily breakdown query failed."
        size="panel"
      />
    );
  }
  const daily = dailyRes.data;
  const label = insightsRewardsPeriodLabel(period);
  if (daily.length === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={CalendarRange}
          title={`No daily activity in ${label.toLowerCase()}`}
          description="No rakeback was claimed in the selected window."
          compact
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="surface-sheen surface-raise relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/70 p-4 sm:p-5">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-12 -top-12 size-32 rounded-full bg-rose-500/[0.08] blur-2xl"
          />
          <div className="relative">
            <SectionHeading
              icon={CalendarRange}
              title={`Daily rakeback — ${label}`}
            />
            <div className="mt-3">
              <RakebackDailyChart daily={daily} />
            </div>
          </div>
        </div>
      </FadeIn>

      <FadeIn>
        <SectionHeading icon={CalendarRange} title="Day-by-day breakdown" />
        <div className="mt-3 overflow-hidden rounded-2xl border bg-card">
          <div className="max-h-[36rem] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-card text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                <tr className="border-b border-border/40">
                  <th className="px-4 py-2 text-left sm:px-5">Date</th>
                  <th className="px-3 py-2 text-right">Claims</th>
                  <th className="px-3 py-2 text-right">Rakeback</th>
                  <th className="px-3 py-2 text-right">Avg / claim</th>
                  <th className="px-3 py-2 text-right">Distinct users</th>
                </tr>
              </thead>
              <tbody>
                {[...daily].reverse().map((d) => (
                  <tr
                    key={d.date}
                    className="border-t border-border/40 hover:bg-muted/30"
                  >
                    <td className="px-4 py-2 tabular-nums text-muted-foreground sm:px-5">
                      {d.date}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatNumber(d.count)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-rose-600 dark:text-rose-400">
                      {formatCurrency(d.volume)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatCurrency(d.avg)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatNumber(d.distinctClaimants)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </FadeIn>
    </div>
  );
}
