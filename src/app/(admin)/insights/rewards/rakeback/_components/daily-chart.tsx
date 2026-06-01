"use client";

import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { EmptyState } from "@/components/empty-state";
import { TrendingDown } from "lucide-react";
import { formatCompactUsd, formatCurrency } from "@/lib/utils/format";
import type { RakebackDailyPoint } from "@/lib/queries/insights-rewards/rakeback/daily";

// House-POV: rakeback is money we GIVE users → cost → rose. Same hue
// the rest of the rewards surfaces use so the page reads as a family.
const ROSE = "#f43f5e";

const chartConfig = {
  volume: { label: "Rakeback paid", color: ROSE },
} satisfies ChartConfig;

/**
 * Daily rakeback area chart. Single rose series — total rakeback paid
 * out per day. Same animation contract as the rewards-chart on
 * /rewards/analytics so the look stays consistent across the page set.
 */
export function RakebackDailyChart({ daily }: { daily: RakebackDailyPoint[] }) {
  if (daily.length === 0) {
    return (
      <EmptyState
        icon={TrendingDown}
        title="No rakeback paid in this window"
        description="No rakeback claims landed in the selected period. Try a longer window."
        compact
      />
    );
  }

  return (
    <ChartContainer
      config={chartConfig}
      className="aspect-auto h-[280px] w-full md:h-[340px]"
    >
      <AreaChart data={daily} margin={{ left: 6, right: 6 }} accessibilityLayer>
        <defs>
          <linearGradient id="rakebackDailyGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={ROSE} stopOpacity={0.35} />
            <stop offset="100%" stopColor={ROSE} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          tickFormatter={(v: string) => v.slice(5)}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          width={70}
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
          dataKey="volume"
          stroke={ROSE}
          fill="url(#rakebackDailyGradient)"
          strokeWidth={2}
          animationDuration={700}
          animationEasing="ease-out"
        />
      </AreaChart>
    </ChartContainer>
  );
}
