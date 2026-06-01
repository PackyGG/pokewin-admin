"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { EmptyState } from "@/components/empty-state";
import { PieChart as PieChartIcon } from "lucide-react";
import { formatCurrency, formatNumber } from "@/lib/utils/format";

const ROSE = "#f43f5e";

const chartConfig = {
  count: { label: "Bonuses", color: ROSE },
} satisfies ChartConfig;

/**
 * 5-bucket histogram of bonus / deposit ratio (0–5%, 5–15%, 15–30%,
 * 30–60%, 60%+). Same rose family + tooltip pattern as
 * `CapAmountHistogram` so the two charts visually pair on the Cap &
 * Ratio tab.
 *
 * House-POV: each bar represents bonus payouts (house cost) per
 * deposit-size category → rose.
 */
export function RatioBucketsBars({
  buckets,
}: {
  buckets: Array<{
    label: string;
    count: number;
    volume: number;
  }>;
}) {
  if (buckets.every((b) => b.count === 0)) {
    return (
      <EmptyState
        icon={PieChartIcon}
        title="No paired bonuses"
        description="No bonus↔deposit pairings in window to bucket."
        compact
      />
    );
  }
  return (
    <ChartContainer
      config={chartConfig}
      className="aspect-auto h-[260px] w-full md:h-[320px]"
    >
      <BarChart data={buckets} margin={{ left: 6, right: 6, top: 8 }} accessibilityLayer>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          interval={0}
          tick={{ fontSize: 11 }}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          width={48}
          tickFormatter={(v: number) => formatNumber(v)}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              formatter={(value, _name, item) => {
                const volume = (item?.payload as { volume?: number } | undefined)
                  ?.volume;
                return `${formatNumber(Number(value))} · ${formatCurrency(volume ?? 0)} vol`;
              }}
              hideIndicator
            />
          }
        />
        <Bar
          dataKey="count"
          fill={ROSE}
          radius={[4, 4, 0, 0]}
          animationDuration={700}
          animationEasing="ease-out"
        />
      </BarChart>
    </ChartContainer>
  );
}
