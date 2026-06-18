"use client";

import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
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
import { TrendingDown } from "lucide-react";
import { formatCurrency } from "@/lib/utils/format";

const ROSE = "#f43f5e";
const EMERALD = "#10b981";

/**
 * Daily deposit-bonus spend (rose bars, $) + the effective bonus rate
 * (emerald line, % of deposits) across the last 90d, with a reference
 * marker at the new-system cutover. House-POV: bonus is a house cost
 * (rose); the falling rate after cutover is the savings story.
 */
const config = {
  bonus: { label: "Bonus paid", color: ROSE },
  ratePct: { label: "Eff. rate %", color: EMERALD },
} satisfies ChartConfig;

export function DepositBonusTrendChart({
  data,
  cutoverDate,
}: {
  data: Array<{ date: string; bonus: number; ratePct: number | null }>;
  cutoverDate: string;
}) {
  if (data.every((d) => d.bonus === 0)) {
    return (
      <EmptyState
        icon={TrendingDown}
        title="No bonus activity"
        description="No completed deposit bonuses in the last 90 days."
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
          width={52}
          tickFormatter={(v: number) => `$${v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v}`}
        />
        <YAxis
          yAxisId="right"
          orientation="right"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          width={44}
          tickFormatter={(v: number) => `${v}%`}
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
                name === "bonus"
                  ? `${formatCurrency(Number(value))} paid`
                  : `${Number(value).toFixed(2)}% of deposits`
              }
            />
          }
        />
        <ReferenceLine
          yAxisId="left"
          x={cutoverDate}
          stroke={EMERALD}
          strokeDasharray="4 4"
          label={{
            value: "New system",
            position: "insideTopRight",
            fill: EMERALD,
            fontSize: 11,
          }}
        />
        <Bar
          yAxisId="left"
          dataKey="bonus"
          fill={ROSE}
          radius={[3, 3, 0, 0]}
          animationDuration={700}
          animationEasing="ease-out"
        />
        <Line
          yAxisId="right"
          type="monotone"
          dataKey="ratePct"
          stroke={EMERALD}
          strokeWidth={2}
          dot={false}
          connectNulls
          animationDuration={700}
          animationEasing="ease-out"
        />
      </ComposedChart>
    </ChartContainer>
  );
}
