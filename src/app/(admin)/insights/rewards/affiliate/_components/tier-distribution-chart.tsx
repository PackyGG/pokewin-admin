"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { formatNumber } from "@/lib/utils/format";

/**
 * Affiliate count per tier (Level 1–8) as a bar chart.
 *
 * The affiliate COUNT is a neutral population metric, not a money flow,
 * so the bars use the neutral blue chart accent (House-POV money colours
 * — rose for commission cost — live on the table/KPI side, not here).
 */
const BLUE = "#3b82f6";

const chartConfig = {
  affiliateCount: { label: "Affiliates", color: BLUE },
} satisfies ChartConfig;

export function TierDistributionChart({
  data,
  height = 300,
}: {
  data: Array<{ label: string; affiliateCount: number }>;
  height?: number;
}) {
  if (data.length === 0) {
    return (
      <div
        style={{ height }}
        className="grid place-items-center text-xs text-muted-foreground"
      >
        No data
      </div>
    );
  }
  return (
    <ChartContainer
      config={chartConfig}
      className="aspect-auto w-full"
      style={{ height }}
    >
      <BarChart data={data} margin={{ left: 6, right: 6, top: 16 }} accessibilityLayer>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={6}
          fontSize={10}
          interval={0}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickMargin={4}
          width={40}
          fontSize={10}
          allowDecimals={false}
          tickFormatter={(v: number) => formatNumber(v)}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              formatter={(value) => formatNumber(Number(value))}
              hideIndicator
            />
          }
        />
        <Bar
          dataKey="affiliateCount"
          fill={BLUE}
          radius={[4, 4, 0, 0]}
          animationDuration={700}
          animationEasing="ease-out"
        />
      </BarChart>
    </ChartContainer>
  );
}
