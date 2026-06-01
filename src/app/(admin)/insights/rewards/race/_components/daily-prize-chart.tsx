"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  XAxis,
  YAxis,
} from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { formatCurrency } from "@/lib/utils/format";

// House-POV: race prizes are payouts → rose. Same hex the rest of
// rewards-insights uses for cost-side series.
const ROSE = "#f43f5e";

const chartConfig: ChartConfig = {
  total: {
    label: "Prize $",
    color: ROSE,
  },
};

/**
 * Daily race-prize line chart for the Overview tab. Area + line in
 * rose, with axis tick formatting using the standard formatCurrency
 * util. Animation duration matches the rest of the rewards-insights
 * charts so the page reads cohesively.
 */
export function RaceDailyPrizeChart({
  data,
  height = 280,
}: {
  data: Array<{ date: string; total: number; count: number }>;
  height?: number;
}) {
  // Pretty-print the X-axis label (yyyy-mm-dd → "MMM d") without pulling
  // a date lib into a client component — Date.parse is already in scope.
  function formatTick(value: string): string {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  return (
    <ChartContainer
      config={chartConfig}
      className="aspect-auto w-full"
      style={{ height }}
    >
      <AreaChart data={data} margin={{ left: 10, right: 12, top: 12 }}>
        <defs>
          <linearGradient id="raceDailyPrizeFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={ROSE} stopOpacity={0.5} />
            <stop offset="95%" stopColor={ROSE} stopOpacity={0.05} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          fontSize={11}
          tickFormatter={formatTick}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          fontSize={11}
          width={64}
          tickFormatter={(v) => formatCurrency(Number(v))}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(label) => formatTick(String(label))}
              formatter={(value) => formatCurrency(Number(value))}
              indicator="dot"
            />
          }
        />
        <Area
          type="monotone"
          dataKey="total"
          stroke={ROSE}
          fill="url(#raceDailyPrizeFill)"
          strokeWidth={2}
          animationDuration={700}
          animationEasing="ease-out"
        />
      </AreaChart>
    </ChartContainer>
  );
}
