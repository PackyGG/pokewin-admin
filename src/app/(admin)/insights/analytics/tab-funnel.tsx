import Link from "next/link";
import { Filter, TrendingDown } from "lucide-react";
import { FadeIn } from "@/components/fade-in";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/utils/format";
import {
  getInsightsFunnel,
  parseFunnelBreakdown,
  type FunnelBreakdownKey,
  type FunnelBucket,
} from "@/lib/queries/insights-analytics/funnel";
import { EmptyState } from "@/components/empty-state";
import { INSIGHTS_PERIOD_LABELS, type InsightsPeriod } from "./types";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";

/**
 * Funnel tab — clicks → signups → first deposit → first wager → repeat
 * → MAW, optionally broken down by source or country. Each bucket
 * renders its own funnel so admins can compare channel quality.
 */
export async function FunnelInsightsTab({
  period,
  breakdownBy,
}: {
  period: InsightsPeriod;
  breakdownBy: string | undefined;
}) {
  const bk = parseFunnelBreakdown(breakdownBy);
  const { data, error } = await safeQuery(
    () => getInsightsFunnel(period, bk),
    null,
    "insights-analytics.funnel",
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="Analytics — Funnel"
        hint="The funnel query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }

  return (
    <FadeIn>
      <div className="space-y-4">
        <Intro period={period} breakdownBy={bk} />
        <BreakdownToggle current={bk} />

        {data.buckets.length === 0 || data.buckets.every((b) => b.steps[0]?.count === 0) ? (
          <EmptyState
            icon={Filter}
            title="No funnel data"
            description="No clicks or signups landed in the selected window. Try a longer period."
          />
        ) : (
          <div
            className={cn(
              "grid gap-4",
              data.buckets.length === 1 ? "grid-cols-1" : "md:grid-cols-2 xl:grid-cols-3",
            )}
          >
            {data.buckets.map((bucket) => (
              <FunnelCard key={bucket.key} bucket={bucket} />
            ))}
          </div>
        )}
      </div>
    </FadeIn>
  );
}

function FunnelCard({ bucket }: { bucket: FunnelBucket }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{bucket.label}</CardTitle>
        <p className="text-xs text-muted-foreground">
          {bucket.steps[0]
            ? `${formatNumber(bucket.steps[0].count)} ${bucket.steps[0].label.toLowerCase()}`
            : "No data"}
        </p>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {bucket.steps.map((step, i) => {
            const widthPct = Math.max(2, step.conversionFromTop * 100);
            const dropoffPct =
              step.dropoffFromPrev === null ? null : step.dropoffFromPrev * 100;
            return (
              <div key={step.key} className="space-y-1">
                <div className="flex flex-col gap-x-3 gap-y-0.5 text-[11px] sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 flex-col">
                    <span className="font-medium text-foreground">{step.label}</span>
                    <span className="text-muted-foreground">{step.description}</span>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-0.5 sm:text-right">
                    {dropoffPct !== null && dropoffPct > 0 && (
                      <span className="flex items-center gap-0.5 text-rose-500 dark:text-rose-400">
                        <TrendingDown className="size-3" />
                        −{dropoffPct.toFixed(1)}%
                      </span>
                    )}
                    <span className="text-muted-foreground tabular-nums">
                      {(step.conversionFromTop * 100).toFixed(1)}%
                    </span>
                    <span className="min-w-10 font-semibold tabular-nums">
                      {formatNumber(step.count)}
                    </span>
                  </div>
                </div>
                <div className="relative h-5 overflow-hidden rounded-md bg-muted/40">
                  <div
                    className={cn("h-full rounded-md transition-all", colorFor(i))}
                    style={{ width: `${widthPct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function colorFor(i: number): string {
  const palette = [
    "bg-cyan-500",
    "bg-blue-500",
    "bg-indigo-500",
    "bg-violet-500",
    "bg-purple-500",
    "bg-emerald-500",
  ];
  return palette[i] ?? "bg-primary";
}

function Intro({
  period,
  breakdownBy,
}: {
  period: InsightsPeriod;
  breakdownBy: FunnelBreakdownKey;
}) {
  const breakdownLabel =
    breakdownBy === "source"
      ? " split by signup source"
      : breakdownBy === "country"
        ? " split by country"
        : "";
  return (
    <div className="flex items-start gap-3 rounded-xl border bg-muted/20 p-4">
      <div className="rounded-md bg-primary/10 p-1.5">
        <Filter className="size-4 text-primary" />
      </div>
      <div className="text-sm">
        <h3 className="font-semibold">Acquisition funnel{breakdownLabel}</h3>
        <p className="text-muted-foreground">
          Visitor → signup → deposit → wager → repeat depositor → monthly
          active wagerer. Each step is sized relative to the funnel&apos;s
          top step. Period: {INSIGHTS_PERIOD_LABELS[period].toLowerCase()}.
          Clicks attach only to the &quot;Overall&quot; bucket (no
          per-channel attribution at click time).
        </p>
      </div>
    </div>
  );
}

function BreakdownToggle({ current }: { current: FunnelBreakdownKey }) {
  const options: { value: FunnelBreakdownKey; label: string }[] = [
    { value: "none", label: "Overall" },
    { value: "source", label: "By source" },
    { value: "country", label: "By country" },
  ];
  return (
    <div className="flex gap-1 rounded-md border bg-muted/40 p-1 self-start w-fit">
      {options.map(({ value, label }) => (
        <Link
          key={value}
          href={`?tab=funnel&funnelBy=${value}`}
          replace
          prefetch={false}
          className={cn(
            "rounded-sm px-3 py-1 text-xs font-medium transition-colors",
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
