"use client";

import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { formatCompactUsd, formatCurrency } from "@/lib/utils/format";

/**
 * Daily commission area chart for the affiliate overview. Rose
 * (house-cost POV — commission is money the house GIVES affiliates).
 * Mirrors the chart aesthetic on /insights/rewards Overview so the
 * pages stay cohesive.
 */
const ROSE = "#f43f5e";

const chartConfig = {
  commission: { label: "Commission paid", color: ROSE },
} satisfies ChartConfig;

export function CommissionChart({
  data,
  height = 320,
}: {
  data: Array<{ date: string; commission: number }>;
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
      <AreaChart data={data} margin={{ left: 6, right: 6 }} accessibilityLayer>
        <defs>
          <linearGradient
            id="affiliateCommissionGradient"
            x1="0"
            y1="0"
            x2="0"
            y2="1"
          >
            <stop offset="0%" stopColor={ROSE} stopOpacity={0.34} />
            <stop offset="100%" stopColor={ROSE} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tickMargin={6}
          fontSize={10}
          tickFormatter={(v: string) => v.slice(5)}
          minTickGap={20}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickMargin={4}
          width={50}
          fontSize={10}
          tickFormatter={formatCompactUsd}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              formatter={(value) => formatCurrency(Number(value))}
              hideIndicator
            />
          }
        />
        <Area
          type="monotone"
          dataKey="commission"
          stroke={ROSE}
          fill="url(#affiliateCommissionGradient)"
          strokeWidth={1.5}
          animationDuration={700}
          animationEasing="ease-out"
        />
      </AreaChart>
    </ChartContainer>
  );
}
