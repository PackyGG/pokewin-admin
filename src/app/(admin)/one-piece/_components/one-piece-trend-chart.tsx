"use client";

import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
} from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { EmptyState } from "@/components/empty-state";
import { Anchor } from "lucide-react";
import { formatCurrency, formatNumber } from "@/lib/utils/format";

const EMERALD = "#10b981";
const SKY = "#38bdf8";

/**
 * Daily One Piece pack activity over the last 30d: opens (sky bars, count) +
 * revenue (emerald line, $). House-POV: revenue is money the house takes in
 * from pack wagers → emerald. Opens are a neutral activity count → sky.
 */
const config = {
  opens: { label: "Opens", color: SKY },
  revenue: { label: "Revenue", color: EMERALD },
} satisfies ChartConfig;

export function OnePieceTrendChart({
  data,
}: {
  data: Array<{ date: string; opens: number; revenue: number }>;
}) {
  if (data.every((d) => d.opens === 0)) {
    return (
      <EmptyState
        icon={Anchor}
        title="No pack opens yet"
        description="No One Piece pack opens in the last 30 days."
        compact
      />
    );
  }
  return (
    <ChartContainer
      config={config}
      className="aspect-auto h-[280px] w-full md:h-[320px]"
    >
      <ComposedChart data={data} margin={{ left: 6, right: 6, top: 8 }} accessibilityLayer>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={36}
          tick={{ fontSize: 11 }}
          tickFormatter={(v: string) =>
            new Date(v + "T00:00:00Z").toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              timeZone: "UTC",
            })
          }
        />
        <YAxis
          yAxisId="left"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          width={44}
          allowDecimals={false}
        />
        <YAxis
          yAxisId="right"
          orientation="right"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          width={52}
          tickFormatter={(v: number) => `$${v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v}`}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(label) =>
                new Date(label + "T00:00:00Z").toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                  timeZone: "UTC",
                })
              }
              formatter={(value, name) =>
                name === "opens"
                  ? `${formatNumber(Number(value))} opens`
                  : `${formatCurrency(Number(value))} revenue`
              }
            />
          }
        />
        <Bar
          yAxisId="left"
          dataKey="opens"
          fill={SKY}
          radius={[3, 3, 0, 0]}
          animationDuration={700}
          animationEasing="ease-out"
        />
        <Line
          yAxisId="right"
          type="monotone"
          dataKey="revenue"
          stroke={EMERALD}
          strokeWidth={2}
          dot={false}
          animationDuration={700}
          animationEasing="ease-out"
        />
      </ComposedChart>
    </ChartContainer>
  );
}
