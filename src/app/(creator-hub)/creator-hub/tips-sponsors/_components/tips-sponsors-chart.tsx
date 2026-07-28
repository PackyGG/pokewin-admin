"use client";

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Gift } from "lucide-react";

import { formatCompactUsd } from "@/lib/utils/format";

import type { TipsSponsorChartRow } from "../_queries/tips-sponsors-data";

// Two genuinely distinguishable series hues: tips keep the House-cost rose,
// sponsors use the admin dashboard's primary chart token (blue family) —
// replacing the old pair of near-identical rose hexes (#fb7185 / #f43f5e).
const TIPS_COLOR = "#f43f5e";
const SPONSORS_COLOR = "var(--chart-1)";

/**
 * Daily house-funded tips vs battle sponsorships. The window is a FIXED
 * 30 days regardless of the page's period chip — labelled explicitly.
 */
export function TipsSponsorsChart({ data }: { data: TipsSponsorChartRow[] }) {
  // House chart convention (see pack-studio tier-distribution-chart):
  // recharts animations are skipped entirely under prefers-reduced-motion.
  const prefersReducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  return (
    <div className="rounded-xl border bg-card p-4 sm:p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="text-sm font-semibold">
          Daily spend · fixed 30 days
        </span>
        <Gift className="size-4 text-rose-500" aria-hidden />
      </div>
      <div className="h-[280px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={data}
            margin={{ top: 6, right: 4, left: 4, bottom: 0 }}
          >
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="currentColor"
              className="text-border/50"
              vertical={false}
            />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 10 }}
              stroke="currentColor"
              className="text-muted-foreground"
              tickMargin={8}
              tickFormatter={(v: string) => v.slice(5)}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 10 }}
              stroke="currentColor"
              className="text-muted-foreground"
              width={56}
              tickMargin={8}
              tickFormatter={formatCompactUsd}
            />
            <Tooltip
              contentStyle={{
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: "var(--card)",
                fontSize: 12,
              }}
              formatter={(value: number, name: string) => [
                `$${Number(value).toFixed(2)}`,
                name,
              ]}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Line
              type="monotone"
              dataKey="tips"
              name="Tips"
              stroke={TIPS_COLOR}
              strokeWidth={2}
              dot={false}
              isAnimationActive={!prefersReducedMotion}
              animationDuration={700}
              animationEasing="ease-out"
            />
            <Line
              type="monotone"
              dataKey="sponsors"
              name="Sponsors"
              stroke={SPONSORS_COLOR}
              strokeWidth={2}
              dot={false}
              isAnimationActive={!prefersReducedMotion}
              animationDuration={700}
              animationEasing="ease-out"
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
