"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  XAxis,
  YAxis,
} from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { formatNumber } from "@/lib/utils/format";

/**
 * Daily signup + claim area chart for the Overview tab.
 *
 * Two layered areas — signups (blue, neutral acquisition) and claims
 * (rose, house cost). Same animation parameters as the other admin
 * charts so this reads as one family. Container height fixed at 280px
 * so the Overview tab leads with the chart without it dominating.
 *
 * House-POV: signups are NEUTRAL (acquisition event) → blue. Claims
 * are house cost → rose.
 */
export function SignupDailyChart({
  daily,
}: {
  daily: Array<{
    date: string;
    signups: number;
    claims: number;
    cost: number;
  }>;
}) {
  const chartConfig = {
    signups: { label: "Signups", color: "#3b82f6" },
    claims: { label: "Claims", color: "#f43f5e" },
  } satisfies ChartConfig;

  return (
    <ChartContainer
      config={chartConfig}
      className="aspect-auto w-full"
      style={{ height: 280 }}
    >
      <AreaChart data={daily} margin={{ left: 6, right: 6, top: 8 }} accessibilityLayer>
        <defs>
          <linearGradient id="fillSignups" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.5} />
            <stop offset="95%" stopColor="#3b82f6" stopOpacity={0.05} />
          </linearGradient>
          <linearGradient id="fillClaims" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#f43f5e" stopOpacity={0.5} />
            <stop offset="95%" stopColor="#f43f5e" stopOpacity={0.05} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          fontSize={11}
          minTickGap={32}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          width={42}
          tickFormatter={(v) => formatNumber(Number(v))}
          fontSize={11}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              formatter={(value) => formatNumber(Number(value))}
              hideIndicator
            />
          }
        />
        <Area
          type="monotone"
          dataKey="signups"
          stroke="#3b82f6"
          strokeWidth={2}
          fill="url(#fillSignups)"
          animationDuration={700}
          animationEasing="ease-out"
        />
        <Area
          type="monotone"
          dataKey="claims"
          stroke="#f43f5e"
          strokeWidth={2}
          fill="url(#fillClaims)"
          animationDuration={700}
          animationEasing="ease-out"
        />
      </AreaChart>
    </ChartContainer>
  );
}
