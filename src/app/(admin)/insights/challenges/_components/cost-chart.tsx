"use client";

import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { formatCurrency } from "@/lib/utils/format";

// House-POV: a challenge prize is money paid OUT to a user → a house COST
// → rose. Same hex the rest of the insights cost-side series use.
const ROSE = "#f43f5e";

const chartConfig: ChartConfig = {
  total: { label: "Prize cost $", color: ROSE },
};

/**
 * Daily challenge-prize cost area chart. Rose fill + line, currency axis,
 * animation matching the rest of the insights charts so the page reads
 * cohesively.
 */
export function ChallengesCostChart({
  data,
  height = 280,
}: {
  data: Array<{ date: string; total: number; count: number }>;
  height?: number;
}) {
  function formatTick(value: string): string {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return parsed.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  }

  return (
    <ChartContainer
      config={chartConfig}
      className="aspect-auto w-full"
      style={{ height }}
    >
      <AreaChart data={data} margin={{ left: 10, right: 12, top: 12 }}>
        <defs>
          <linearGradient id="challengeCostFill" x1="0" y1="0" x2="0" y2="1">
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
          fill="url(#challengeCostFill)"
          strokeWidth={2}
          animationDuration={700}
          animationEasing="ease-out"
        />
      </AreaChart>
    </ChartContainer>
  );
}
