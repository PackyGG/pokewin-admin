"use client";

import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { EmptyState } from "@/components/empty-state";
import { Gift } from "lucide-react";
import { formatCompactUsd, formatCurrency } from "@/lib/utils/format";

// House-POV: deposit bonus is money the house GIVES users → a house
// cost → rose. Mirrors the rose used by RewardsCostChart so the two
// charts on /rewards/analytics read as one family.
const ROSE = "#f43f5e";

const chartConfig = {
  volume: { label: "Bonus volume", color: ROSE },
} satisfies ChartConfig;

/**
 * Daily deposit-bonus volume area chart. Single rose series — sum of
 * ABS(amount) for every `deposit_bonus` ledger row on each day. Same
 * recharts + ChartContainer setup as RewardsCostChart so styling stays
 * consistent across the page.
 */
export function DepositBonusChart({
  daily,
}: {
  daily: Array<{ date: string; volume: number; count: number }>;
}) {
  if (daily.length === 0) {
    return (
      <EmptyState
        icon={Gift}
        title="No deposit bonuses in this window"
        description="No deposit bonuses were awarded in the selected period. Try a longer period."
        compact
      />
    );
  }

  return (
    <ChartContainer
      config={chartConfig}
      className="aspect-auto h-[260px] w-full md:h-[320px]"
    >
      <AreaChart data={daily} margin={{ left: 6, right: 6 }} accessibilityLayer>
        <defs>
          <linearGradient id="depositBonusGradient" x1="0" y1="0" x2="0" y2="1">
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
          fill="url(#depositBonusGradient)"
          strokeWidth={2}
          animationDuration={700}
          animationEasing="ease-out"
        />
      </AreaChart>
    </ChartContainer>
  );
}
