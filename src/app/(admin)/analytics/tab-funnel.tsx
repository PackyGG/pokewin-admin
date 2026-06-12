import Link from "next/link";
import { Filter, TrendingDown } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatNumber } from "@/lib/utils/format";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { cn } from "@/lib/utils";
import {
  getFunnelData,
  type FunnelPeriod,
} from "@/lib/queries/analytics-funnel";
import type { AnalyticsPeriod } from "./types";

/**
 * Acquisition funnel: clicks → signups → first-deposit → first-wager →
 * repeat-depositor → monthly-active-wagerer. Each row visualizes count
 * proportional to the top step; a separate column shows drop-off vs the
 * previous step so the admin can spot the single biggest leaks.
 *
 * Uses its own period filter (top-right of the card) because the hero
 * period includes "today" which isn't useful for a funnel — most of the
 * later steps require multi-day windows to populate.
 */
export async function FunnelTab({
  period: heroPeriod,
}: {
  period: AnalyticsPeriod;
}) {
  // Map hero period → funnel period. "today" isn't offered on the funnel,
  // so fall back to 7d.
  const funnelPeriod: FunnelPeriod =
    heroPeriod === "today"
      ? "7d"
      : heroPeriod === "7d" ||
          heroPeriod === "30d" ||
          heroPeriod === "90d" ||
          heroPeriod === "all"
        ? heroPeriod
        : "30d";

  const { data, error } = await safeQuery(
    () => getFunnelData(funnelPeriod),
    null,
    "analytics.funnel",
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="Acquisition funnel"
        hint="The funnel query failed — refresh to retry."
        size="panel"
      />
    );
  }

  return (
    <FadeIn>
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-xl border bg-muted/20 p-4">
          <div className="rounded-md bg-primary/10 p-1.5">
            <Filter className="size-4 text-primary" />
          </div>
          <div className="text-sm">
            <h3 className="font-semibold">Acquisition funnel</h3>
            <p className="text-muted-foreground">
              Visitor → signup → deposit → wager → repeat deposit → monthly
              active. Each step&apos;s bar is sized to its share of the top
              step. Drop-off % highlights the single biggest leak in the
              funnel.
            </p>
          </div>
        </div>

        <Card>
          <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle className="text-sm font-medium">
              Funnel — {periodLabel(funnelPeriod)}
            </CardTitle>
            <FunnelPeriodFilter current={funnelPeriod} />
          </CardHeader>
          <CardContent>
            <FunnelBars data={data} />
          </CardContent>
        </Card>
      </div>
    </FadeIn>
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

function FunnelPeriodFilter({ current }: { current: FunnelPeriod }) {
  // The period here maps 1:1 to the hero PeriodFilter. Clicking a chip
  // updates `?period=` which propagates back through the page.
  const periods: { value: FunnelPeriod; label: string }[] = [
    { value: "7d", label: "7d" },
    { value: "30d", label: "30d" },
    { value: "90d", label: "90d" },
    { value: "all", label: "All" },
  ];
  return (
    <div className="flex flex-wrap gap-1 rounded-md border bg-muted/40 p-0.5">
      {periods.map(({ value, label }) => (
        <Link
          key={value}
          href={`?tab=funnel&period=${value}`}
          replace
          prefetch={false}
          className={cn(
            "rounded-sm px-2 py-0.5 text-xs font-medium transition-colors",
            current === value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {label}
        </Link>
      ))}
    </div>
  );
}

function FunnelBars({ data }: { data: Awaited<ReturnType<typeof getFunnelData>> }) {
  const { steps } = data;
  // Color progression: cyan → blue → emerald through the funnel. No
  // dogmatic house-POV coloring here because none of these metrics are
  // signed money.
  const colorFor = (i: number): string => {
    const palette = [
      "bg-cyan-500",
      "bg-blue-500",
      "bg-indigo-500",
      "bg-violet-500",
      "bg-purple-500",
      "bg-emerald-500",
    ];
    return palette[i] ?? "bg-primary";
  };

  if (steps.length === 0 || steps[0].count === 0) {
    return (
      <EmptyState
        icon={Filter}
        title="No funnel data"
        description="No tracked clicks landed in the selected window, so there's nothing to step through yet. Try a longer period."
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
            {/* Label + counter row. On phones the right-side cluster
                (drop-off, % of top, count) wraps below the label so a
                long step description doesn't push the count column
                off-screen. */}
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

      {/* Summary strip at the bottom */}
      <div className="mt-4 grid gap-3 rounded-lg border bg-muted/20 p-3 text-xs sm:grid-cols-3">
        <div>
          <p className="text-muted-foreground">Click → signup</p>
          <p className="mt-0.5 font-semibold tabular-nums">
            {rate(steps, "clicks", "signups")}
          </p>
        </div>
        <div>
          <p className="text-muted-foreground">Signup → first wager</p>
          <p className="mt-0.5 font-semibold tabular-nums">
            {rate(steps, "signups", "first_wager")}
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
  steps: Awaited<ReturnType<typeof getFunnelData>>["steps"],
  from: string,
  to: string,
): string {
  const a = steps.find((s) => s.key === from)?.count ?? 0;
  const b = steps.find((s) => s.key === to)?.count ?? 0;
  if (a === 0) return "—";
  return `${((b / a) * 100).toFixed(1)}%`;
}
