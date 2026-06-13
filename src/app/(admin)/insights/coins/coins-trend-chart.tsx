"use client";

import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { EmptyState } from "@/components/empty-state";
import { Coins } from "lucide-react";
import { formatNumber } from "@/lib/utils/format";
import type { CoinDailyPoint } from "@/lib/queries/insights-coins";

/**
 * Daily earned-vs-spent trend for the global coin/shard economy.
 *
 * House-POV (secondary currency, NOT USD):
 *   - SPENT = coins/shards users wagered into games → the house takes in →
 *     emerald.
 *   - EARNED = coins/shards paid out to users (wins + grants) → a house
 *     liability → rose.
 *
 * Two stacked areas so the day's gross flow on both sides reads at a glance;
 * the tooltip carries the raw shard counts (compact axis, full counts in the
 * tooltip). Same animation contract (700ms ease-out) as the rest of the
 * insights chart set so the page reads as a family.
 */
const EMERALD = "#10b981";
const ROSE = "#f43f5e";

const chartConfig = {
  spent: { label: "Spent (house in)", color: EMERALD },
  earned: { label: "Earned (house out)", color: ROSE },
} satisfies ChartConfig;

/** Compact shard-count axis label (NOT currency — shards are not USD). */
function formatCompactShards(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return `${Math.round(v)}`;
}

export function CoinsTrendChart({ daily }: { daily: CoinDailyPoint[] }) {
  if (daily.length === 0) {
    return (
      <EmptyState
        icon={Coins}
        title="No coin/shard activity in this window"
        description="No coin or shard transactions landed in the selected period. Try a longer window."
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
          <linearGradient id="coinsSpentGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={EMERALD} stopOpacity={0.35} />
            <stop offset="100%" stopColor={EMERALD} stopOpacity={0.02} />
          </linearGradient>
          <linearGradient id="coinsEarnedGradient" x1="0" y1="0" x2="0" y2="1">
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
          width={56}
          tickFormatter={formatCompactShards}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              formatter={(value) => formatNumber(Math.round(Number(value)))}
            />
          }
        />
        <Area
          type="monotone"
          dataKey="spent"
          stroke={EMERALD}
          fill="url(#coinsSpentGradient)"
          strokeWidth={2}
          animationDuration={700}
          animationEasing="ease-out"
        />
        <Area
          type="monotone"
          dataKey="earned"
          stroke={ROSE}
          fill="url(#coinsEarnedGradient)"
          strokeWidth={2}
          animationDuration={700}
          animationEasing="ease-out"
        />
      </AreaChart>
    </ChartContainer>
  );
}
