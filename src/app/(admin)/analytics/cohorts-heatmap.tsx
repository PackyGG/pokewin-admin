"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/empty-state";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import type { CohortData, CohortGranularity } from "@/lib/queries/analytics-cohorts";

/**
 * A two-grid layout: left side shows retention % per cohort × period,
 * right side shows revenue retention per cohort × period. Both use the
 * same blue-gradient intensity scale (darker = higher) so the admin can
 * eyeball patterns across both metrics with one mental model.
 */
export function CohortsHeatmap({ data }: { data: CohortData }) {
  const { rows, maxPeriods } = data;

  // Revenue intensity normalizes to the max absolute revenue value across
  // the entire grid. Negative revenue (admin P&L loss to user) uses rose
  // per house-POV rule; positive uses emerald so the grid carries financial
  // sentiment at a glance.
  const maxRevenue = Math.max(
    ...rows.flatMap((r) => r.revenue.map((v) => Math.abs(v))),
    1,
  );

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Users className="size-4 text-primary" />
            Retention % by cohort
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Each cell = % of the cohort still placing wagers in that period.
            Hover for counts.
          </p>
        </CardHeader>
        <CardContent>
          <HeatmapTable
            rows={rows}
            maxPeriods={maxPeriods}
            granularity={data.granularity}
            mode="retention"
            maxValue={1}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Users className="size-4 text-primary" />
            Revenue per cohort (GGR, house POV)
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Monetary retention — wagers minus payouts per cohort per period.
          </p>
        </CardHeader>
        <CardContent>
          <HeatmapTable
            rows={rows}
            maxPeriods={maxPeriods}
            granularity={data.granularity}
            mode="revenue"
            maxValue={maxRevenue}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function HeatmapTable({
  rows,
  maxPeriods,
  granularity,
  mode,
  maxValue,
}: {
  rows: CohortData["rows"];
  maxPeriods: number;
  granularity: CohortGranularity;
  mode: "retention" | "revenue";
  maxValue: number;
}) {
  const periodLabel = granularity === "week" ? "W" : "M";

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title="No cohort data"
        description="No signup cohorts fall inside the selected window yet. Try switching the grouping granularity."
        compact
      />
    );
  }

  // The cohort table can be 8+ period columns wide on a 30/90-day
  // window — too wide for any phone. Wrap in horizontal scroll and pin
  // the cohort label column so the user always knows which cohort row
  // the cells belong to as they pan. `overscroll-x-contain` keeps the
  // momentum swipe inside the grid instead of bouncing the whole page,
  // and a right-edge fade hints there are more period columns off-screen
  // (the left column is sticky, so only the right side needs the cue).
  return (
    <div>
      <div className="relative">
        <div className="overflow-x-auto overscroll-x-contain">
          <table className="w-full text-xs border-separate border-spacing-1">
          <thead>
            <tr className="text-muted-foreground">
              <th className="sticky left-0 z-10 bg-card text-left font-medium">
                Cohort
              </th>
              <th className="text-right font-medium">Size</th>
              {Array.from({ length: maxPeriods }).map((_, i) => (
                <th key={i} className="text-center font-medium">
                  {periodLabel}
                  {i === maxPeriods - 1 ? `${i}+` : i}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              return (
                <tr key={row.cohort}>
                  <td className="sticky left-0 z-10 truncate bg-card pr-2 font-medium">
                    {row.label}
                  </td>
                  <td className="pr-2 text-right tabular-nums text-muted-foreground">
                    {formatNumber(row.size)}
                  </td>
                  {row.retained.map((retained, i) => {
                    const revenue = row.revenue[i] ?? 0;
                    return mode === "retention" ? (
                      <RetentionCell
                        key={i}
                        retained={retained}
                        revenue={revenue}
                        size={row.size}
                      />
                    ) : (
                      <RevenueCell
                        key={i}
                        revenue={revenue}
                        retained={retained}
                        size={row.size}
                        maxValue={maxValue}
                      />
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
          </table>
        </div>
        {/* Right-edge fade affordance — signals more period columns when
            the grid overflows. pointer-events-none so it never blocks the
            scroll/tap. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-card to-transparent"
        />
      </div>
      <CohortsToggle granularity={granularity} />
    </div>
  );
}

/**
 * Cell with blue-gradient intensity = retention %. The `value` prop is
 * the normalized 0..1 retention rate. We clamp to 0.02 min so even tiny
 * values are visually distinguishable from empty cells.
 */
function RetentionCell({
  retained,
  revenue,
  size,
}: {
  retained: number;
  revenue: number;
  size: number;
}) {
  const pct = size > 0 ? retained / size : 0;
  const intensity = pct;
  const opacity = intensity > 0 ? Math.max(0.08, Math.min(1, intensity)) : 0;
  const label = retained === 0 ? "—" : `${(pct * 100).toFixed(0)}%`;
  return (
    <td
      className={cn(
        "relative min-w-[42px] rounded px-2 py-1.5 text-center tabular-nums",
        retained === 0 ? "text-muted-foreground" : "text-foreground",
      )}
      style={{
        backgroundColor:
          opacity > 0 ? `rgb(59 130 246 / ${opacity})` : "transparent",
      }}
      title={
        size > 0
          ? `${retained.toLocaleString()} / ${size.toLocaleString()} (${(pct * 100).toFixed(1)}%)${revenue ? `\n${formatCurrency(revenue)} GGR` : ""}`
          : undefined
      }
    >
      {label}
    </td>
  );
}

function RevenueCell({
  revenue,
  retained,
  size,
  maxValue,
}: {
  revenue: number;
  retained: number;
  size: number;
  maxValue: number;
}) {
  const intensity = maxValue > 0 ? Math.abs(revenue) / maxValue : 0;
  const opacity = intensity > 0 ? Math.max(0.08, Math.min(1, intensity)) : 0;
  const rgb = revenue >= 0 ? "16 185 129" : "244 63 94"; // emerald-500 / rose-500
  const label = revenue === 0 ? "—" : formatCompact(revenue);
  return (
    <td
      className={cn(
        "relative min-w-[42px] rounded px-2 py-1.5 text-center tabular-nums",
        revenue === 0 ? "text-muted-foreground" : "text-foreground",
      )}
      style={{
        backgroundColor:
          opacity > 0 ? `rgb(${rgb} / ${opacity})` : "transparent",
      }}
      title={
        retained > 0
          ? `${formatCurrency(revenue)} from ${retained.toLocaleString()} active users (cohort size ${size.toLocaleString()})`
          : undefined
      }
    >
      {label}
    </td>
  );
}

function formatCompact(v: number): string {
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function CohortsToggle({ granularity }: { granularity: CohortGranularity }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function hrefFor(g: CohortGranularity): string {
    const p = new URLSearchParams(searchParams.toString());
    p.set("cohortBy", g);
    return `${pathname}?${p.toString()}`;
  }

  return (
    <div className="mt-3 flex gap-1">
      <span className="text-xs text-muted-foreground self-center mr-2">
        Group by:
      </span>
      {(["week", "month"] as const).map((g) => (
        <Link
          key={g}
          href={hrefFor(g)}
          replace
          prefetch={false}
          className={cn(
            "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
            granularity === g
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
          )}
        >
          {g === "week" ? "Week" : "Month"}
        </Link>
      ))}
    </div>
  );
}
