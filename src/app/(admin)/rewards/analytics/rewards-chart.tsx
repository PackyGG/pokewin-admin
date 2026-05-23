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
import type { RewardsDailyPoint } from "@/lib/queries/rewards-analytics";

// House-POV: rewards are money the house GIVES users → a house cost →
// rose everywhere. rose-500 (#f43f5e) keeps the chart in the same
// semantic family as the rose KpiTiles / table amounts on this page.
const ROSE = "#f43f5e";

const chartConfig = {
  total: { label: "Reward cost", color: ROSE },
} satisfies ChartConfig;

/**
 * Daily total reward-cost area chart. Single rose series — the sum of
 * every reward category paid out that day. Animated in at 700ms
 * ease-out per the modern page pattern; recharts ResponsiveContainer
 * (via ChartContainer) handles sizing.
 */
export function RewardsCostChart({ daily }: { daily: RewardsDailyPoint[] }) {
  if (daily.length === 0) {
    return (
      <EmptyState
        icon={TrendingDown}
        title="No reward payouts in this window"
        description="No rewards were paid out in the selected period. Try a longer period."
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
          <linearGradient id="rewardsCostGradient" x1="0" y1="0" x2="0" y2="1">
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
          dataKey="total"
          stroke={ROSE}
          fill="url(#rewardsCostGradient)"
          strokeWidth={2}
          animationDuration={700}
          animationEasing="ease-out"
        />
      </AreaChart>
    </ChartContainer>
  );
}
