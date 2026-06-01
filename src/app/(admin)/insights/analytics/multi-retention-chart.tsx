"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  type ChartConfig,
  ChartContainer,
} from "@/components/ui/chart";
import type { RetentionSeries } from "@/lib/queries/insights-analytics/retention";

const PALETTE = [
  "rgb(59 130 246)",
  "rgb(16 185 129)",
  "rgb(244 63 94)",
  "rgb(168 85 247)",
  "rgb(245 158 11)",
  "rgb(6 182 212)",
];

/**
 * Multi-line retention curve. One line per series (default 1 line, more
 * when a breakdown is selected). Y axis is fraction (0..1) shown as %.
 */
export function MultiRetentionChart({ series }: { series: RetentionSeries[] }) {
  // Coalesce per-day points across all series into a single recharts
  // dataset where each row is `{ day, <seriesKey>: pct }`.
  const days = new Set<number>();
  for (const s of series) for (const p of s.curve) days.add(p.day);
  const sortedDays = Array.from(days).sort((a, b) => a - b);

  const data = sortedDays.map((day) => {
    const row: Record<string, number> = { day };
    for (const s of series) {
      const p = s.curve.find((c) => c.day === day);
      row[s.key] = p ? p.pct : 0;
    }
    return row;
  });

  const config: ChartConfig = {};
  series.forEach((s, i) => {
    config[s.key] = { label: s.label, color: PALETTE[i % PALETTE.length] };
  });

  return (
    <ChartContainer config={config} className="h-[300px] w-full md:h-[360px]">
      <LineChart data={data} accessibilityLayer>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="day"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          fontSize={11}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          width={48}
          fontSize={11}
          tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
          domain={[0, "dataMax"]}
        />
        <Tooltip
          formatter={(value, name) => [
            `${(Number(value) * 100).toFixed(1)}%`,
            String(name),
          ]}
          labelFormatter={(label) => `Day ${label}`}
        />
        {series.map((s, i) => (
          <Line
            key={s.key}
            type="monotone"
            dataKey={s.key}
            stroke={PALETTE[i % PALETTE.length]}
            strokeWidth={2}
            dot={false}
            animationDuration={700}
            animationEasing="ease-out"
          />
        ))}
      </LineChart>
    </ChartContainer>
  );
}
