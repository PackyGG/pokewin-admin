"use client";

import {
  Bar,
  CartesianGrid,
  Line,
  XAxis,
  YAxis,
  ReferenceLine,
  ComposedChart,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
} from "@/components/ui/chart";
import { formatCompactUsd } from "@/lib/utils/format";

type Point = {
  date: string;
  ggr: number;
  cost: number;
  pnl: number;
};

/**
 * Daily canonical GGR vs reward giveback vs NGR over the active window.
 *
 * GGR is the gross gaming margin captured; the cost bar is the day's
 * house-funded reward giveback (GGR − NGR); NGR is the net gaming margin
 * the house kept after rewards. All three come from the canonical
 * per-day metric series (`getDailyGamingMetrics`), so the daily GGR/NGR
 * reconcile with the headline by construction. Lets the operator see if
 * reward spend is GROWING relative to GGR over time.
 *
 * House-POV colors: GGR = blue (the gross line), NGR = emerald (house
 * keeps), reward giveback = rose (money back to users). The cost bar
 * sits under the GGR line so the visible headroom between the bar top
 * and the GGR line is the day's NGR.
 */
const chartConfig = {
  ggr: { label: "GGR", color: "rgb(59 130 246)" },
  cost: { label: "Reward giveback", color: "rgb(244 63 94)" },
  pnl: { label: "NGR", color: "rgb(16 185 129)" },
} satisfies ChartConfig;

export function CostTrendChart({ data }: { data: Point[] }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium">
          GGR vs reward giveback vs NGR — daily
        </CardTitle>
        <p className="text-[11px] text-muted-foreground">
          The rose bar is the day&apos;s house-funded reward giveback. The gap
          between the GGR line and the bar top is the day&apos;s net gaming
          margin (NGR).
        </p>
      </CardHeader>
      <CardContent>
        <ChartContainer config={chartConfig} className="h-[280px] w-full">
          <ComposedChart data={data} accessibilityLayer>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={6}
              tickFormatter={(v) => String(v).slice(5)}
              fontSize={10}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickMargin={6}
              width={56}
              tickFormatter={formatCompactUsd}
              fontSize={10}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  formatter={(value) => `$${Number(value).toFixed(2)}`}
                />
              }
            />
            <ChartLegend content={<ChartLegendContent />} />
            <ReferenceLine y={0} stroke="rgb(120 120 120)" strokeDasharray="3 3" />
            <Bar
              dataKey="cost"
              fill="rgb(244 63 94)"
              fillOpacity={0.55}
              animationDuration={700}
              animationEasing="ease-out"
              radius={[3, 3, 0, 0]}
            />
            <Line
              type="monotone"
              dataKey="ggr"
              stroke="rgb(59 130 246)"
              strokeWidth={2}
              dot={false}
              animationDuration={700}
              animationEasing="ease-out"
            />
            <Line
              type="monotone"
              dataKey="pnl"
              stroke="rgb(16 185 129)"
              strokeWidth={2}
              dot={false}
              animationDuration={700}
              animationEasing="ease-out"
            />
          </ComposedChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
