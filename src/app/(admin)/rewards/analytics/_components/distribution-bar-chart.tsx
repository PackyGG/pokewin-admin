"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { formatCurrency, formatNumber } from "@/lib/utils/format";

// House-POV: every reward distribution is money flowing OUT to users
// → rose. Same hex as the rest of /rewards/analytics so the bar chart
// reads as one family with the area charts above.
const ROSE = "#f43f5e";

/**
 * Generic small vertical bar chart used by per-category tabs to render
 * bucket distributions (deposit/bonus ratio buckets, race-winner
 * position buckets, signup time-of-day, etc.). The caller passes one
 * data row per bucket; the chart renders count OR volume on the y-axis
 * depending on `metric`.
 *
 * Single rose series. Animation duration matches the area charts so
 * the page reads cohesively. The container height stays compact so a
 * distribution sits cleanly under a KPI strip without dominating the
 * tab.
 */
export function DistributionBarChart({
  data,
  metric,
  height = 200,
}: {
  data: Array<{ label: string; count: number; volume: number }>;
  /**
   * "count" → bar height is the bucket's row count (claimants, prizes,
   * winners, etc.). "volume" → bar height is the bucket's USD volume.
   * Default "count" because most distributions read more clearly as
   * counts than dollars when comparing buckets.
   */
  metric?: "count" | "volume";
  /** Optional pixel height override. Defaults to 200px. */
  height?: number;
}) {
  const dataKey = metric === "volume" ? "volume" : "count";
  const chartConfig = {
    [dataKey]: {
      label: metric === "volume" ? "Volume" : "Count",
      color: ROSE,
    },
  } satisfies ChartConfig;
  const formatter = (v: number | string) =>
    metric === "volume"
      ? formatCurrency(Number(v))
      : formatNumber(Number(v));
  return (
    <ChartContainer
      config={chartConfig}
      className="aspect-auto w-full"
      style={{ height }}
    >
      <BarChart data={data} margin={{ left: 6, right: 6, top: 8 }} accessibilityLayer>
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
          width={50}
          tickFormatter={formatter}
          fontSize={11}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              formatter={(value) => formatter(value as number)}
              hideIndicator
            />
          }
        />
        <Bar
          dataKey={dataKey}
          fill={ROSE}
          radius={[4, 4, 0, 0]}
          animationDuration={700}
          animationEasing="ease-out"
        />
      </BarChart>
    </ChartContainer>
  );
}
