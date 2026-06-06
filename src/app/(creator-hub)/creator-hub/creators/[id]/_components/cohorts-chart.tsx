"use client";

import * as React from "react";
import {
  Bar,
  ComposedChart,
  Line,
  ResponsiveContainer,
  CartesianGrid,
  Tooltip,
  XAxis,
  YAxis,
  Legend,
} from "recharts";
import { Users } from "lucide-react";

import { formatCurrency, formatNumber } from "@/lib/utils/format";

/**
 * Cohorts chart — per signup-month funnel (signups / FTDs / repeat depositors)
 * as grouped bars, with deposits-LTV as an overlaid line on a second axis.
 *
 * Matches the sibling `activity-chart.tsx` recharts style exactly (raw
 * recharts, theme-token grid/axes, `animationDuration={700}` /
 * `ease-out`) so the whole creator/[id] tab set reads as one family.
 *
 * House-POV colors:
 *   • Signups / FTDs / repeat = neutral funnel COUNTS → blue / cyan / violet.
 *   • Deposits LTV = cash INTO the house → emerald.
 *
 * Client component (recharts needs the browser); every prop is a serializable
 * primitive array — NO function props cross the server→client boundary. Data
 * arrives oldest→newest (caller reverses the newest-first table order) so the
 * x-axis reads left-to-right chronologically. Empty → labeled empty state, no
 * fabricated bars.
 */

export type CohortChartPoint = {
  /** "Mar 2026". */
  label: string;
  signups: number;
  ftds: number;
  repeat: number;
  depositsUsd: number;
};

export function CohortsChart({ series }: { series: CohortChartPoint[] }) {
  const hasSeries = series.length > 0;

  if (!hasSeries) {
    return (
      <div className="rounded-2xl border bg-card p-4 sm:p-5">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <Users className="size-4 text-blue-500" />
          Cohort funnel &amp; LTV
        </div>
        <div className="flex h-[220px] w-full items-center justify-center rounded-md border border-dashed border-border/60 px-4 text-center text-[11px] text-muted-foreground">
          No referred signups in the lookback window yet.
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border bg-card p-4 sm:p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <Users className="size-4 text-blue-500" />
          Cohort funnel &amp; LTV
        </span>
        <span className="text-[11px] text-muted-foreground">by signup month</span>
      </div>

      <div className="h-[260px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={series}
            margin={{ top: 6, right: 8, left: 4, bottom: 0 }}
          >
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="currentColor"
              className="text-border/50"
              vertical={false}
            />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 10 }}
              stroke="currentColor"
              className="text-muted-foreground"
              minTickGap={16}
            />
            {/* Left axis — funnel counts. */}
            <YAxis
              yAxisId="count"
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 10 }}
              stroke="currentColor"
              className="text-muted-foreground"
              width={36}
              allowDecimals={false}
            />
            {/* Right axis — deposits LTV ($). */}
            <YAxis
              yAxisId="usd"
              orientation="right"
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 10 }}
              stroke="currentColor"
              className="text-muted-foreground"
              width={52}
              tickFormatter={(v: number) => formatCurrency(v)}
            />
            <Tooltip
              contentStyle={{
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: "var(--card)",
                fontSize: 12,
              }}
              formatter={(value: number, name: string) =>
                name === "Deposits (LTV)"
                  ? [formatCurrency(value), name]
                  : [formatNumber(value), name]
              }
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar
              yAxisId="count"
              dataKey="signups"
              name="Signups"
              fill="#60a5fa"
              radius={[3, 3, 0, 0]}
              maxBarSize={28}
              animationDuration={700}
              animationEasing="ease-out"
            />
            <Bar
              yAxisId="count"
              dataKey="ftds"
              name="FTDs"
              fill="#22d3ee"
              radius={[3, 3, 0, 0]}
              maxBarSize={28}
              animationDuration={700}
              animationEasing="ease-out"
            />
            <Bar
              yAxisId="count"
              dataKey="repeat"
              name="Repeat"
              fill="#a78bfa"
              radius={[3, 3, 0, 0]}
              maxBarSize={28}
              animationDuration={700}
              animationEasing="ease-out"
            />
            <Line
              yAxisId="usd"
              type="monotone"
              dataKey="depositsUsd"
              name="Deposits (LTV)"
              stroke="#34d399"
              strokeWidth={2}
              dot={{ r: 2 }}
              animationDuration={700}
              animationEasing="ease-out"
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
