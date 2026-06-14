"use client";

import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { EmptyState } from "@/components/empty-state";
import { Sparkles } from "lucide-react";
import { formatCurrency, formatCompactUsd } from "@/lib/utils/format";
import type { XpSalesDailyPoint } from "@/lib/queries/insights-xp-sales";

/**
 * Daily XP-sales revenue trend for the global /xp-sales page.
 *
 * House-POV: a user buying XP spends their own (withdrawable) balance → the
 * house takes in → emerald. So the daily revenue area is emerald. Same
 * animation contract (700ms ease-out) as the rest of the insights chart set
 * so the page reads as a family.
 */
const EMERALD = "#10b981";

const chartConfig = {
  revenue: { label: "XP revenue (house in)", color: EMERALD },
} satisfies ChartConfig;

export function XpSalesTrendChart({ daily }: { daily: XpSalesDailyPoint[] }) {
  if (daily.length === 0) {
    return (
      <EmptyState
        icon={Sparkles}
        title="No XP sales in this window"
        description="No XP purchases landed in the selected period. Try a longer window."
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
          <linearGradient id="xpRevenueGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={EMERALD} stopOpacity={0.35} />
            <stop offset="100%" stopColor={EMERALD} stopOpacity={0.02} />
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
          tickFormatter={formatCompactUsd}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              formatter={(value) => formatCurrency(Number(value))}
            />
          }
        />
        <Area
          type="monotone"
          dataKey="revenue"
          stroke={EMERALD}
          fill="url(#xpRevenueGradient)"
          strokeWidth={2}
          animationDuration={700}
          animationEasing="ease-out"
        />
      </AreaChart>
    </ChartContainer>
  );
}
