"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { formatNumber } from "@/lib/utils/format";

const ROSE = "#f43f5e";

/**
 * Vertical bar histogram for the time-to-claim distribution.
 *
 * One bar per non-uniform bucket. Y-axis = claimant count. Tooltip
 * shows the bucket label + count. Same chart family (rose) as the
 * rest of the rewards-analytics charts.
 */
export function TimeToClaimHistogram({
  buckets,
}: {
  buckets: Array<{ label: string; count: number; edgeHours: number }>;
}) {
  const config = {
    count: { label: "Claimants", color: ROSE },
  } satisfies ChartConfig;
  return (
    <ChartContainer
      config={config}
      className="aspect-auto w-full"
      style={{ height: 240 }}
    >
      <BarChart data={buckets} margin={{ left: 6, right: 6, top: 8 }} accessibilityLayer>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          fontSize={11}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          width={48}
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
