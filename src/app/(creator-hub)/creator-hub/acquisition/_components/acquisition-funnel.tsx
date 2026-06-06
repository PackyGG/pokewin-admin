import { Filter, TrendingDown } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/utils/format";
import type { FunnelData, FunnelPeriod } from "@/lib/queries/analytics-funnel";

/**
 * Platform acquisition funnel — clicks → signups → first deposit (FTD) →
 * first wager → repeat depositor → monthly active wagerer.
 *
 * Hub-styled port of the funnel visualization from /analytics (tab-funnel).
 * Presentation-only: the page fetches `getFunnelData` once and passes the
 * result here (also used for the FTD KPI).
 */

export function AcquisitionFunnel({
  period,
  data,
}: {
  period: FunnelPeriod;
  data: FunnelData;
}) {
  return (
    <div className="rounded-2xl border bg-card p-4 sm:p-5">
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Filter className="size-4 text-pink-500" />
          <div>
            <h3 className="text-sm font-semibold">Acquisition funnel</h3>
            <p className="text-xs text-muted-foreground">
              {periodLabel(period)} · click → signup → FTD → wager → repeat →
              MAW
            </p>
          </div>
        </div>
      </div>

      <FunnelBars data={data} />
    </div>
  );
}

function periodLabel(p: FunnelPeriod): string {
  switch (p) {
    case "7d":
      return "Last 7 days";
    case "30d":
      return "Last 30 days";
    case "90d":
      return "Last 90 days";
    case "all":
      return "All time";
  }
}

function FunnelBars({ data }: { data: FunnelData }) {
  const { steps } = data;

  const colorFor = (i: number): string => {
    const palette = [
      "bg-sky-500",
      "bg-blue-500",
      "bg-emerald-500",
      "bg-emerald-600",
      "bg-violet-500",
      "bg-pink-500",
    ];
    return palette[i] ?? "bg-primary";
  };

  if (steps.length === 0 || steps[0].count === 0) {
    return (
      <EmptyState
        icon={Filter}
        title="No funnel data"
        description="No tracked clicks landed in the selected window. Try a longer period."
        compact
      />
    );
  }

  return (
    <div className="space-y-3">
      {steps.map((step, i) => {
        const widthPct = Math.max(2, step.conversionFromTop * 100);
        const dropoffPct =
          step.dropoffFromPrev === null ? null : step.dropoffFromPrev * 100;
        return (
          <div key={step.key} className="space-y-1">
            <div className="flex flex-col gap-x-4 gap-y-1 text-xs sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 flex-col">
                <span className="font-medium text-foreground">{step.label}</span>
                <span className="text-muted-foreground">{step.description}</span>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 sm:text-right">
                {dropoffPct !== null && dropoffPct > 0 && (
                  <span className="flex items-center gap-1 text-rose-500 dark:text-rose-400">
                    <TrendingDown className="size-3" />
                    −{dropoffPct.toFixed(1)}%
                  </span>
                )}
                <span className="text-muted-foreground tabular-nums">
                  {(step.conversionFromTop * 100).toFixed(1)}% of top
                </span>
                <span className="min-w-12 font-semibold tabular-nums sm:min-w-16">
                  {formatNumber(step.count)}
                </span>
              </div>
            </div>
            <div className="relative h-7 overflow-hidden rounded-md bg-muted/40 sm:h-8">
              <div
                className={cn(
                  "h-full rounded-md transition-all",
                  colorFor(i),
                )}
                style={{ width: `${widthPct}%` }}
              />
            </div>
          </div>
        );
      })}

      <div className="mt-4 grid gap-3 rounded-lg border bg-muted/20 p-3 text-xs sm:grid-cols-3">
        <div>
          <p className="text-muted-foreground">Click → signup</p>
          <p className="mt-0.5 font-semibold tabular-nums">
            {rate(steps, "clicks", "signups")}
          </p>
        </div>
        <div>
          <p className="text-muted-foreground">Signup → FTD</p>
          <p className="mt-0.5 font-semibold tabular-nums">
            {rate(steps, "signups", "first_deposit")}
          </p>
        </div>
        <div>
          <p className="text-muted-foreground">Signup → monthly active</p>
          <p className="mt-0.5 font-semibold tabular-nums">
            {rate(steps, "signups", "maw")}
          </p>
        </div>
      </div>
    </div>
  );
}

function rate(
  steps: FunnelData["steps"],
  from: string,
  to: string,
): string {
  const a = steps.find((s) => s.key === from)?.count ?? 0;
  const b = steps.find((s) => s.key === to)?.count ?? 0;
  if (a === 0) return "—";
  return `${((b / a) * 100).toFixed(1)}%`;
}
