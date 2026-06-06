"use client";

import * as React from "react";
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  CartesianGrid,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { LineChart as LineChartIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCompactUsd } from "@/lib/utils/format";

/**
 * Creator Hub dashboard — time-series chart card (Wager / Deposits) in the
 * 3-up row. Uses recharts in the house style (animated area, emerald for
 * house-gain series).
 *
 * HONEST DATA STATE (v1): the real, windowed TOTAL is shown as the
 * headline (wired from `getAllCreatorsNetGgr().legs.wagersTotal` for the
 * Wager card). There is NO existing per-bucket time-series query for the
 * creator cohort, so we do NOT fabricate a line — when `series` is empty
 * the card renders an empty recharts grid + an explicit "hourly breakdown
 * not wired yet" note. Once a bucketed query exists, pass `series` and the
 * area renders for real.
 *
 * Client component (recharts needs the browser). Props are serializable
 * (data array + pre-formatted strings), so it's safe to mount from the
 * Server Component page.
 */

export type HubChartPoint = {
  /** Bucket label for the x-axis (e.g. "12:00"). */
  label: string;
  /** Numeric value for the y-axis. */
  value: number;
};

export function HubChartCard({
  title,
  headline,
  series = [],
  placeholderNote,
}: {
  title: string;
  /** Pre-formatted real total (null → em-dash). */
  headline: string | null;
  /** Bucketed series; empty → placeholder grid (no fabricated line). */
  series?: HubChartPoint[];
  placeholderNote?: string;
}) {
  const hasSeries = series.length > 0;
  // Stable gradient id per title so two cards on the same page don't clash.
  const gradId = React.useId();

  return (
    <div className="rounded-2xl border bg-card p-4 sm:p-5">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-sm font-semibold">{title}</span>
        <LineChartIcon className="size-4 text-emerald-500" />
      </div>
      {/* Headline = REAL windowed total (house gain → emerald). */}
      <p className="text-2xl font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
        {headline ?? <span className="text-muted-foreground/60">—</span>}
      </p>

      <div className="mt-3 h-[160px] w-full">
        {hasSeries ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={series}
              margin={{ top: 6, right: 4, left: 4, bottom: 0 }}
            >
              <defs>
                <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#34d399" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="#34d399" stopOpacity={0} />
                </linearGradient>
              </defs>
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
                minTickGap={24}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 10 }}
                stroke="currentColor"
                className="text-muted-foreground"
                width={48}
                tickFormatter={(v: number) => formatCompactUsd(v)}
              />
              <Tooltip
                cursor={{ stroke: "rgba(52,211,153,0.4)" }}
                formatter={(v: number) => [formatCompactUsd(v), title]}
                contentStyle={{
                  borderRadius: 8,
                  border: "1px solid var(--border)",
                  background: "var(--card)",
                  fontSize: 12,
                }}
              />
              <Area
                type="monotone"
                dataKey="value"
                stroke="#34d399"
                strokeWidth={2}
                fill={`url(#${gradId})`}
                animationDuration={700}
                animationEasing="ease-out"
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          // Placeholder: empty recharts-style grid + an honest note. No
          // fabricated data points.
          <div className="relative flex h-full w-full flex-col">
            <div
              aria-hidden
              className="flex-1 rounded-md border border-dashed border-border/60 bg-[linear-gradient(to_bottom,transparent_calc(50%-0.5px),var(--border)_50%,transparent_calc(50%+0.5px)),linear-gradient(to_bottom,transparent_calc(25%-0.5px),color-mix(in_oklab,var(--border)_50%,transparent)_25%,transparent_calc(25%+0.5px)),linear-gradient(to_bottom,transparent_calc(75%-0.5px),color-mix(in_oklab,var(--border)_50%,transparent)_75%,transparent_calc(75%+0.5px))]"
            />
            <p
              className={cn(
                "pointer-events-none absolute inset-0 flex items-center justify-center px-4 text-center text-[11px] text-muted-foreground",
              )}
            >
              {placeholderNote ??
                "Hourly breakdown not wired yet — total above is live."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
