"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { EmptyState } from "@/components/empty-state";
import { BarChart3 } from "lucide-react";
import { formatCurrency, formatNumber } from "@/lib/utils/format";

const ROSE = "#f43f5e";

const chartConfig = {
  count: { label: "Bonuses", color: ROSE },
} satisfies ChartConfig;

/**
 * 8-bucket histogram of bonus amounts, spanning $0 → cap value. Each
 * bar shows the count of bonuses in that band. Volume per bucket is
 * available in the tooltip.
 *
 * Single rose series — matches the rest of the page's deposit-bonus
 * cost colour family. `animationDuration` mirrors the DepositBonusChart
 * so the visual rhythm is consistent across the page.
 */
export function CapAmountHistogram({
  buckets,
}: {
  buckets: Array<{
    label: string;
    min: number;
    max: number;
    count: number;
    volume: number;
  }>;
}) {
  if (buckets.length === 0 || buckets.every((b) => b.count === 0)) {
    return (
      <EmptyState
        icon={BarChart3}
        title="No data to histogram"
        description="No bonuses in window to distribute."
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
          tick={{ fontSize: 10 }}
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
