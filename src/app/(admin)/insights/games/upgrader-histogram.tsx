"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatCompactUsd, formatNumber } from "@/lib/utils/format";

/**
 * Histogram of target-multiplier buckets for the Upgrader tab — bar
 * height = bet count per bucket. Cohort grouping colours the bars:
 *
 *   Low rollers (<2×, 2–5×)        → emerald (house gains — low-ev play)
 *   Mid rollers (5–10×)            → blue
 *   Risk takers (10–25×, 25–100×)  → amber
 *   Whales (100×+)                 → purple
 *   Unknown                        → muted
 *
 * House-POV note: bar colour is the cohort hue, NOT the P&L tint, so
 * the operator can scan distribution without conflating it with the
 * margin signal (which lives in the table above).
 */
export type UpgraderHistogramPoint = {
  label: string;
  cohort: string;
  bets: number;
  wager: number;
};

const COHORT_COLORS: Record<string, string> = {
  "Low rollers": "rgb(16 185 129)",
  "Mid rollers": "rgb(59 130 246)",
  "Risk takers": "rgb(245 158 11)",
  Whales: "rgb(168 85 247)",
  Other: "rgb(148 163 184)",
};

export function UpgraderHistogram({
  data,
}: {
  data: UpgraderHistogramPoint[];
}) {
  const points = data.filter((d) => d.bets > 0);
  if (points.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
        No plays to distribute.
      </div>
    );
  }
  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={points} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="currentColor" opacity={0.1} />
          <XAxis
            dataKey="label"
            tick={{ fill: "currentColor", opacity: 0.7, fontSize: 11 }}
          />
          <YAxis
            tick={{ fill: "currentColor", opacity: 0.6, fontSize: 11 }}
            tickFormatter={(v) => formatNumber(Number(v))}
            width={48}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "hsl(var(--popover))",
              border: "1px solid hsl(var(--border))",
              borderRadius: 8,
              fontSize: 12,
            }}
            formatter={(value, name, props) => {
              const item = props.payload as
                | UpgraderHistogramPoint
                | undefined;
              if (name === "bets") {
                return [
                  `${formatNumber(Number(value))} bets · ${formatCompactUsd(item?.wager ?? 0)}`,
                  item?.cohort ?? "Cohort",
                ];
              }
              return [String(value), String(name)];
            }}
          />
          <Bar
            dataKey="bets"
            animationDuration={700}
            animationEasing="ease-out"
            radius={[4, 4, 0, 0]}
          >
            {points.map((p) => (
              <Cell
                key={p.label}
                fill={COHORT_COLORS[p.cohort] ?? COHORT_COLORS.Other}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
