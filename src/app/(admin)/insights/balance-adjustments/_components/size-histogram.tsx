"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { formatNumber } from "@/lib/utils/format";

// Neutral purple for a pure distribution (no House-POV direction — a
// size bucket mixes credits and debits, so a single neutral hue is
// correct here rather than rose/emerald).
const PURPLE = "#a855f7";

const chartConfig = {
  count: { label: "Adjustments", color: PURPLE },
} satisfies ChartConfig;

/**
 * Distribution of adjustment sizes (ABS amount) into fixed buckets.
 * Single neutral series — count of adjustments per size bucket.
 */
export function AdjustmentSizeHistogram({
  buckets,
}: {
  buckets: Array<{ label: string; count: number }>;
}) {
  return (
    <ChartContainer
      config={chartConfig}
      className="aspect-auto h-[240px] w-full md:h-[280px]"
    >
      <BarChart data={buckets} margin={{ left: 6, right: 6 }} accessibilityLayer>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          interval={0}
          fontSize={11}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          width={40}
          allowDecimals={false}
          tickFormatter={(v: number) => formatNumber(v)}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              formatter={(value) => `${formatNumber(Number(value))} adjustments`}
              hideIndicator
            />
          }
        />
        <Bar
          dataKey="count"
          fill={PURPLE}
          radius={[4, 4, 0, 0]}
          animationDuration={700}
          animationEasing="ease-out"
        />
      </BarChart>
    </ChartContainer>
  );
}
